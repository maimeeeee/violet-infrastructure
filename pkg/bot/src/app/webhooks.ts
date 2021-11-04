import { Temporal, toTemporalInstant } from '@js-temporal/polyfill';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { Credentials, Provider } from '@aws-sdk/types';
import type { Logger } from 'winston';
import { Webhooks } from '@octokit/webhooks';
import type { IssueCommentEvent } from '@octokit/webhooks-types';
import type { Octokit } from '@octokit/rest';
import { v4 as uuidv4 } from 'uuid';
import type { BotSecrets, ComputedBotEnv } from '@self/shared/lib/bot-env';
import { z } from 'zod';
import type { Command } from '../util/parse-comment';
import { embedDirective, parseComment } from '../util/parse-comment';
import { createOctokit } from './github-app';
import { cmds } from './cmds';
import type { BasicContext, CommandContext, GeneralEntry, ReplyCmd } from '../type/cmd';
import { renderCommentBody, renderTimestamp } from '../util/comment-render';

// TODO(hardcoded)
const botPrefix = '/';

export const constructFullComment = (
  cmd: ReplyCmd,
  entry: GeneralEntry & Parameters<ReplyCmd['constructComment']>[0],
  values: unknown,
  ctx: BasicContext,
): string => {
  const commentHead = [embedDirective(`mark:${cmd.name}:${entry.uuid}`), `@${entry.callerName}`, '', ''].join('\n');
  const commentBodyStruct = cmd.constructComment(entry, values, ctx);
  const comment = renderCommentBody({
    main: commentBodyStruct.main,
    hints: [
      ...(commentBodyStruct.hints ?? []),
      {
        title: 'メタ情報',
        body: {
          main: [
            `- 最終更新: ${renderTimestamp(Temporal.Instant.fromEpochSeconds(entry.lastUpdate))}`,
            `- ネームスペース: \`${entry.namespace}\``,
            `- uuid: \`${entry.uuid}\``,
          ],
        },
      },
    ],
  });

  const full = commentHead + comment;
  return full;
};

const processRun = async (
  run: Command,
  octokit: Octokit,
  env: ComputedBotEnv,
  payload: IssueCommentEvent,
  botInstallationId: number,
  credentials: Credentials | Provider<Credentials>,
  logger: Logger,
) => {
  logger.info('Trying to run', run.args);
  const [cmdName, ...args] = run.args;
  const cmd = cmds.find((cmd) => cmd.name === cmdName);
  const { id: callerId, login: callerName } = payload.comment.user;

  if (cmd == null) {
    logger.info('Not found');
    const mes = renderCommentBody({
      main: [`@${payload.comment.user.login} エラー。コマンド ${cmdName} は存在しません。`],
      hints: [
        {
          title: 'ヒント',
          body: {
            main: [`- <code>${botPrefix}help</code> でヘルプを表示できます。`],
          },
        },
      ],
    });

    logger.info('Creating comment for failure...');
    await octokit.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.issue.number,
      body: mes,
    });
    return;
  }

  const namespace = `${payload.repository.owner.login.toLowerCase()}-pr-${payload.issue.number}`;
  const ctx: CommandContext = {
    octokit,
    env,
    originalArgs: run.args,
    commentPayload: payload,
    namespace,
    credentials,
    logger,
  };
  const uuid = uuidv4();
  const date = new Date();
  const generalEntry: GeneralEntry = {
    uuid,
    ttl: toTemporalInstant.call(date).add({ hours: 24 * 7 }).epochSeconds,
    name: cmd.name,
    callerId,
    callerName,
    namespace,
    lastUpdate: toTemporalInstant.call(date).epochSeconds,
    commentOwner: payload.repository.owner.login,
    commentRepo: payload.repository.name,
    commentIssueNumber: payload.issue.number,
    commentId: -1,
    botInstallationId,
  };
  const { status, entry, values } = await cmd.main(ctx, args, generalEntry);
  logger.info('Command main process done.', { status, entry, values });

  const fullEntry = { ...entry, ...generalEntry };
  const full = constructFullComment(cmd, fullEntry, values, ctx);

  logger.info('Creating comment for success...');
  const createdComment = await octokit.issues.createComment({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: payload.issue.number,
    body: full,
  });
  logger.info('Comment created', createdComment);
  fullEntry.commentId = createdComment.data.id;

  if (status === 'undone') {
    logger.info('Saving result...');
    const db = new DynamoDB({ credentials, logger });
    await db.putItem({
      TableName: env.BOT_TABLE_NAME,
      Item: marshall(fullEntry),
    });
  }
};

// Webhook doc: https://docs.github.com/en/developers/webhooks-and-events/webhooks/about-webhooks
export const createWebhooks = (
  env: ComputedBotEnv,
  secrets: BotSecrets,
  credentials: Credentials | Provider<Credentials>,
  logger: Logger,
): { webhooks: Webhooks; onAllDone: () => Promise<void> } => {
  const webhooks = new Webhooks({
    secret: secrets.WEBHOOKS_SECRET,
  });

  const waitList = new Set();
  const add = (prom: Promise<unknown>) => {
    waitList.add(prom);
    prom
      .then(() => {
        waitList.delete(prom);
      })
      .catch((e) => {
        waitList.delete(prom);
        throw e;
      });
  };

  webhooks.onAny((all) => {
    logger.info('event received', all.name);
    logger.debug('event received', all);
  });

  webhooks.on('issue_comment', ({ payload }) => {
    const inner = async () => {
      logger.info('Event issue_comment received.');
      if (payload.action !== 'created') return;
      logger.info('comment created', payload.comment.user);
      if (payload.comment.user.type !== 'User') return;
      // TODO(hardcoded)
      if (!['LumaKernel', 'solufa', 'maihrs55', 'shuheiest', 'naoya502'].includes(payload.comment.user.login)) return;
      logger.info('Authentication success.');

      const botInstallationId = z.number().parse(payload.installation?.id);
      const octokit = await createOctokit(env, secrets, botInstallationId);
      const runs = parseComment(payload.comment.body, botPrefix);
      logger.info(`${runs.length} runs detected.`);

      // eslint-disable-next-line no-restricted-syntax
      for await (const run of runs) {
        await processRun(run, octokit, env, payload, botInstallationId, credentials, logger).catch((e) => {
          logger.error(`Error while running ${run.args}`, e);
        });
      }
    };
    add(
      inner().catch((e) => {
        logger.error(`Error while running issue_comment reciever`, e);
      }),
    );
  });
  return {
    webhooks,
    onAllDone: async () => {
      await Promise.all([...waitList]);
    },
  };
};

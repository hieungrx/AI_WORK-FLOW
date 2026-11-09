import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, loadRequest, pendingRequest, saveRequest, transitionRequest, requestPath, stateDirectory, withStateLock, commitStateFiles, recordMetric } from './workflow_state.mjs';
import { assertBindingCurrent, assertNoRecognizableSecrets } from './review_artifact.mjs';
import { buildContract } from './review_contract.mjs';
import { getStageRounds, incrementStageRound, checkRoundBudget } from './review_policy.mjs';

// Transport owns only UI/network interactions. Durable state is owned here.
export async function executeReviewRequest({ root, config, taskId, mode, provider, threadKey, snapshot, openIssues = [], buildPrompt, transport }) {
  let request = loadRequest(root, provider, threadKey);
  if (pendingRequest(request)) {
    if (request.taskId !== taskId || request.mode !== mode || !request.snapshot) throw new Error('PENDING_REQUEST_MISMATCH');
    assertPendingBindingCurrent(root, config, request);
  } else {
    const session = readJson(path.join(stateDirectory(root), 'SESSION_MAP.json'));
    const budget = checkRoundBudget(session, threadKey, [provider], config.maxReviewRounds, mode);
    if (!budget.ok) { const e = new Error('REVIEW_BUDGET_EXHAUSTED'); e.exitCode = 3; throw e; }
    request = {
      schemaVersion: 2, requestId: crypto.randomUUID(), taskId, mode, provider, threadKey,
      binding: snapshot.binding, snapshot, openIssues: structuredClone(openIssues), round: getStageRounds(session, threadKey, provider) + 1,
      status: 'PREPARED', createdAt: new Date().toISOString(),
    };
    request.prompt = buildPrompt(request) + '\n\n' + (mode === 'rescue' ? `REVIEW_REQUEST_ID: ${request.requestId}` : buildContract(request));
    assertNoRecognizableSecrets(request.prompt);
    saveRequest(root, request);
  }
  if (request.status === 'RECEIVED') return request;
  assertPendingBindingCurrent(root, config, request);
  assertNoRecognizableSecrets(request.prompt);
  const context = await transport.prepare(request, request.status !== 'PREPARED');
  // Preparing a browser can take minutes. Refuse to send an artifact that changed meanwhile.
  assertPendingBindingCurrent(root, config, request);
  if (request.status === 'PREPARED') {
    request = { ...request, context, status: 'SENDING', submittedAt: new Date().toISOString() };
    withStateLock(root, () => {
      const sessionFile = path.join(stateDirectory(root), 'SESSION_MAP.json');
      const session = readJson(sessionFile);
      const next = incrementStageRound(session, threadKey, provider);
      if (next !== request.round) throw new Error('ROUND_CHANGED_DURING_PREPARATION');
      session.currentTask = taskId;
      const rel = path.relative(stateDirectory(root), requestPath(root, provider, threadKey)).replace(/\\/g, '/');
      commitStateFiles(root, { 'SESSION_MAP.json': JSON.stringify(session, null, 2) + '\n', [rel]: JSON.stringify(request, null, 2) + '\n' });
    });
    // Once marked SENDING, failures are uncertain. Never automatically click Send again.
    const submitted = await transport.submit(request);
    request = transitionRequest(root, request, 'SENT', { context: { ...context, ...submitted } });
    recordMetric(root, { requestId: request.requestId, taskId, mode, provider, event: 'sent', round: request.round });
  } else if (request.status === 'SENDING') {
    if (!await transport.hasSubmission(request)) throw new Error('UNCERTAIN_SEND: inspect the saved conversation; no automatic resend.');
    request = transitionRequest(root, request, 'SENT', { context: { ...request.context, ...context } });
  }
  const responseText = await transport.receive(request);
  if (!responseText || typeof responseText !== 'string') throw new Error('INCOMPLETE_MENTOR_RESPONSE');
  assertPendingBindingCurrent(root, config, request);
  request = transitionRequest(root, request, 'RECEIVED', { responseText, responseUrl: transport.url?.() || request.context?.url || '' });
  return request;
}

export function assertPendingBindingCurrent(root, config, request) {
  try { return assertBindingCurrent(root, config, request.binding); }
  catch (error) {
    if (!String(error.message).startsWith('STALE_REVIEW:')) throw error;
    throw new Error(`PENDING_REQUEST_STALE: ${request.requestId}; ${error.message} Restore the captured artifact to resume this request, or explicitly archive this pending request before starting another review. Evidence and round counters are preserved.`);
  }
}

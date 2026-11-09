#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig, verifyPlanGuard } from './verify_guard.mjs';

export function evaluateToolCall(root, payload) {
  try {
    const call = payload.toolCall || { name: payload.tool_name, args: payload.tool_input };
    if (!call.name || !call.args || typeof call.args !== 'object') throw new Error('UNKNOWN_TOOL_PAYLOAD');
    // Arbitrary programs can write anywhere: delegate to the host permission policy.
    if (['run_command', 'Bash', 'execute_command', 'exec_command'].includes(call.name)) {
      return { decision: 'force_ask', reason: 'Terminal writes require host approval; file approval is not a shell sandbox.' };
    }
    const rawPaths = ['TargetFile', 'Path', 'file_path', 'path', 'target_file'].map((key) => call.args[key]).filter((v) => typeof v === 'string');
    if (!rawPaths.length) throw new Error('UNKNOWN_WRITE_TARGET');
    const config = loadWorkflowConfig(root);
    for (const raw of rawPaths) {
      if (!raw.trim() || raw.includes('\0')) throw new Error('UNKNOWN_WRITE_TARGET');
      const localRoot = path.resolve(root);
      const relative = path.relative(localRoot, path.resolve(localRoot, raw));
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('WRITE_OUTSIDE_WORKSPACE');
      let current = localRoot;
      for (const part of relative.split(path.sep)) {
        if (process.platform === 'win32' && (/[.: ]$/.test(part) || part.includes(':') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('AMBIGUOUS_WINDOWS_WRITE_TARGET');
        current = path.join(current, part);
        try {
          if (fs.lstatSync(current).isSymbolicLink()) throw new Error('SYMLINK_WRITE_REFUSED');
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      const rel = relative.replace(/\\/g, '/');
      const comparable = process.platform === 'win32' ? rel.toLowerCase() : rel;
      if (/^(?:\.git|\.aws|\.ssh)(?:\/|$)/i.test(rel) || /(?:^|\/)\.env(?:\.|$)/i.test(rel)) return { decision: 'force_ask', reason: 'Repository controls and credentials require explicit host permission.' };
      if (/^\.agents\/(?:scripts|hooks|config\.json|hooks\.json)(?:\/|$)/i.test(rel) || /^\.agents\/state\/(?!CURRENT_PLAN\.md$|HANDOFF\.md$|ROADMAP\.md$|REVIEW_RESPONSE\.md$)/i.test(rel)) return { decision: 'force_ask', reason: 'Controller approvals and workflow configuration require explicit host permission.' };
      if (config.sourceDirs.some((s) => { const scope = process.platform === 'win32' ? s.toLowerCase() : s; return comparable === scope || comparable.startsWith(`${scope}/`); })) {
        const result = verifyPlanGuard(root);
        if (!result.ok) return { decision: 'deny', reason: result.reason };
      }
    }
    return { decision: 'allow' };
  } catch (e) { return { decision: 'deny', reason: e.message }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let result;
  try { result = evaluateToolCall(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), JSON.parse(raw)); }
  catch { result = { decision: 'deny', reason: 'INVALID_HOOK_JSON' }; }
  console.log(JSON.stringify(result));
}

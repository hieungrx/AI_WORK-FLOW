#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig } from './verify_guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(REPO_ROOT, '.agents', 'state');
const CONFIG_FILE = path.join(REPO_ROOT, '.agents', 'config.json');

function parseArgs(argv) {
  let projectName = '';
  let cleanDemo = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--name' && i + 1 < argv.length) {
      projectName = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--name=')) {
      projectName = arg.slice('--name='.length).trim();
    } else if (arg === '--clean-demo') {
      cleanDemo = true;
    }
  }
  return { projectName, cleanDemo };
}

function main() {
  const { projectName: argProjectName, cleanDemo } = parseArgs(process.argv.slice(2));
  const config = loadWorkflowConfig(REPO_ROOT);

  if (argProjectName) {
    config.projectName = argProjectName;
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  // 1. Cấu hình Git Pre-commit Hook dùng chung trong .agents/hooks
  try {
    childProcess.execSync('git config core.hooksPath .agents/hooks', {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('[INIT]: Đã cấu hình git config core.hooksPath .agents/hooks');
  } catch (err) {
    console.warn(`[INIT WARNING]: Không thể chạy git config core.hooksPath: ${err.message}`);
  }

  // 2. Reset toàn bộ trạng thái trong .agents/state/ về khởi tạo sạch sẽ
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const roadmapTemplate = [
    `# ROADMAP: Dự án ${config.projectName}`,
    '',
    '## Mục tiêu',
    'Mô tả mục tiêu tổng thể của dự án tại đây.',
    '',
    '## Danh sách Công việc (Tasks)',
    '- [ ] [WORKER_MODEL: pro] Task 1: Khởi tạo kiến trúc cốt lõi của ứng dụng trong `src/`.',
    '- [ ] [WORKER_MODEL: pro/flash] Task 2: Xây dựng bộ kiểm thử tự động trong `tests/`.',
    '',
  ].join('\n');

  const currentPlanTemplate = [
    '# CURRENT_PLAN: Kế hoạch Thiết kế Kỹ thuật',
    '',
    '(Chưa có kế hoạch thiết kế cho Task hiện tại. Worker Agent sẽ viết kế hoạch tại đây và chạy `node .agents/scripts/ask_mentor.mjs --mode plan --task task-1`).',
    '',
  ].join('\n');

  const mentorFeedbackTemplate = [
    'STATUS: PENDING',
    '',
    '(Đang chờ gửi kế hoạch thiết kế cho ChatGPT Mentor duyệt).',
    '',
  ].join('\n');

  const codeReviewFeedbackTemplate = [
    'CODE_STATUS: PENDING',
    '',
    '(Đang chờ gửi Review Code sau khi hoàn tất Implement và chạy pass test).',
    '',
  ].join('\n');

  const handoffTemplate = [
    '# HANDOFF: Trạng thái Bàn giao Phiên làm việc',
    '',
    '## 1. Bối cảnh hiện tại',
    `- Dự án đã được khởi tạo sạch sẽ với ChatGPT Project: \`${config.projectName}\`.`,
    '- Đã kích hoạt Git Pre-commit Hook tại `.agents/hooks/pre-commit`.',
    '',
    '## 2. Bước tiếp theo (Next Steps)',
    '1. Cập nhật danh sách Task thực tế vào `.agents/state/ROADMAP.md`.',
    '2. Lập kế hoạch cho `Task 1` vào `.agents/state/CURRENT_PLAN.md`.',
    '3. Gửi ChatGPT Mentor duyệt kế hoạch: `node .agents/scripts/ask_mentor.mjs --mode plan --task task-1`.',
    '',
  ].join('\n');

  const sessionMapTemplate = {
    projectName: config.projectName,
    projectUrl: 'https://chatgpt.com/',
    currentTask: 'task-1',
    threads: {},
  };

  const stateLockTemplate = {
    taskId: 'task-1',
    planSha256: '',
    codeSha256: '',
    testExitCode: null,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(STATE_DIR, 'ROADMAP.md'), roadmapTemplate, 'utf8');
  fs.writeFileSync(path.join(STATE_DIR, 'CURRENT_PLAN.md'), currentPlanTemplate, 'utf8');
  fs.writeFileSync(path.join(STATE_DIR, 'MENTOR_FEEDBACK.md'), mentorFeedbackTemplate, 'utf8');
  fs.writeFileSync(path.join(STATE_DIR, 'CODE_REVIEW_FEEDBACK.md'), codeReviewFeedbackTemplate, 'utf8');
  fs.writeFileSync(path.join(STATE_DIR, 'HANDOFF.md'), handoffTemplate, 'utf8');
  fs.writeFileSync(
    path.join(STATE_DIR, 'SESSION_MAP.json'),
    `${JSON.stringify(sessionMapTemplate, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(STATE_DIR, 'STATE_LOCK.json'),
    `${JSON.stringify(stateLockTemplate, null, 2)}\n`,
    'utf8'
  );
  console.log('[INIT]: Đã reset toàn bộ các file trạng thái trong .agents/state/.');

  // 3. Nếu có cờ --clean-demo: xóa các file demo của Todo CLI và tạo thư mục src/, tests/ rỗng
  if (cleanDemo) {
    const demoFiles = [
      'src/todo.js',
      'src/todo.test.js',
      'tests/fs_fault.test.js',
      'tasks.json',
    ];
    for (const relPath of demoFiles) {
      const fullPath = path.join(REPO_ROOT, relPath);
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { force: true });
        console.log(`[INIT]: Đã xóa file demo: ${relPath}`);
      }
    }

    for (const dirName of config.sourceDirs || ['src', 'tests']) {
      const dirPath = path.join(REPO_ROOT, dirName);
      fs.mkdirSync(dirPath, { recursive: true });
    }
    console.log('[INIT]: Đã đảm bảo thư mục src/ và tests/ rỗng sẵn sàng cho dự án mới.');
  }

  console.log(`[INIT HOÀN TẤT]: Dự án "${config.projectName}" đã sẵn sàng!`);
}

main();
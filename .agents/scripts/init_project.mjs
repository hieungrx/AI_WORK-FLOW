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
const PACKAGE_FILE = path.join(REPO_ROOT, 'package.json');
const ASK_MENTOR_SCRIPT = path.join(__dirname, 'ask_mentor.mjs');

function slugifyPackageName(name) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'my-ai-workflow-app';
}

function parseArgs(argv) {
  let projectName = '';
  let cleanDemo = false;
  let offline = false;
  let templateMode = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--name' && i + 1 < argv.length) {
      projectName = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--name=')) {
      projectName = arg.slice('--name='.length).trim();
    } else if (arg === '--clean-demo') {
      cleanDemo = true;
    } else if (arg === '--offline' || arg === '--no-browser') {
      offline = true;
    } else if (arg === '--template') {
      templateMode = true;
    }
  }
  return { projectName, cleanDemo, offline, templateMode };
}

function ensureSourceDirsReady(sourceDirs) {
  for (const dirName of sourceDirs) {
    const dirPath = path.join(REPO_ROOT, dirName);
    fs.mkdirSync(dirPath, { recursive: true });
    const entries = fs.readdirSync(dirPath);
    if (entries.length === 0) {
      fs.writeFileSync(path.join(dirPath, '.gitkeep'), '', 'utf8');
    }
  }
}

function cleanTransientStateFiles() {
  const transientFiles = [
    'GEMINI_FEEDBACK.md',
    'REVIEW_LEDGER.json',
    'TECH_DEBT.md',
    'REVIEW_RESPONSE.md',
    'LAST_REVIEW_BUNDLE.txt',
    'checkpoint.patch',
    '.transition_journal.json',
    'HUMAN_DECISION.json',
    'ESCALATION_SESSION.json',
  ];
  for (const fileName of transientFiles) {
    const fullPath = path.join(STATE_DIR, fileName);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { force: true });
    }
  }
  const snapshotsDir = path.join(STATE_DIR, 'review_snapshots');
  if (fs.existsSync(snapshotsDir)) {
    fs.rmSync(snapshotsDir, { recursive: true, force: true });
  }
}

function updatePackageJson({ resolvedProjectName, templateMode }) {
  if (!fs.existsSync(PACKAGE_FILE)) return;
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
    pkg.name = templateMode ? 'ai-workflow-template' : slugifyPackageName(resolvedProjectName);
    if (
      !pkg.scripts ||
      typeof pkg.scripts.test !== 'string' ||
      pkg.scripts.test.includes('src/todo.test.js')
    ) {
      pkg.scripts = pkg.scripts || {};
      pkg.scripts.test = 'node .agents/scripts/run_tests.mjs';
    }
    fs.writeFileSync(PACKAGE_FILE, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn(`[INIT WARNING]: Không thể cập nhật package.json: ${err.message}`);
  }
}

function main() {
  const {
    projectName: argProjectName,
    cleanDemo,
    offline,
    templateMode,
  } = parseArgs(process.argv.slice(2));

  const workspaceFolderName = path.basename(REPO_ROOT) || 'AI-WORKSPACE';
  const resolvedProjectName = templateMode
    ? ''
    : argProjectName || workspaceFolderName;
  const displayProjectLabel = templateMode
    ? '<TỰ ĐỘNG THEO TÊN THƯ MỤC DỰ ÁN>'
    : resolvedProjectName;

  const loadedConfig = loadWorkflowConfig(REPO_ROOT);
  const rawConfig = fs.existsSync(CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    : {};
  const nextConfig = {
    ...loadedConfig,
    ...rawConfig,
    projectName: resolvedProjectName,
  };

  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  updatePackageJson({ resolvedProjectName, templateMode });

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

  // 2. Reset toàn bộ trạng thái trong .agents/state/ về khởi tạo sạch sẽ (chuẩn v2)
  fs.mkdirSync(STATE_DIR, { recursive: true });
  cleanTransientStateFiles();

  const roadmapTemplate = [
    `# ROADMAP: Dự án ${displayProjectLabel}`,
    '',
    '## Mục tiêu',
    'Mô tả mục tiêu tổng thể của sản phẩm tại đây.',
    '',
    '## Quy ước Thẻ Model & Chuyên gia',
    '- Worker Agent: gắn thẻ `[WORKER_MODEL: pro]` (kiến trúc/phức tạp) hoặc `[WORKER_MODEL: flash]` (đơn giản/kiểm thử).',
    '- Mentor Gate: tự động định tuyến chuyên gia qua `node .agents/scripts/ask_mentor.mjs --mode <plan|review-code|rescue> --task <task_id> --role <role_key>`.',
    '',
    '## Danh sách Công việc (Tasks)',
    '- [ ] [WORKER_MODEL: pro] Task 1: Thiết kế và khởi tạo kiến trúc cốt lõi của ứng dụng trong `src/`.',
    '- [ ] [WORKER_MODEL: pro/flash] Task 2: Xây dựng tính năng chính và bộ kiểm thử tự động trong `tests/`.',
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
    '(Đang chờ gửi kế hoạch thiết kế cho Mentor duyệt).',
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
    `- Dự án đã được khởi tạo sạch sẽ (Tên Project ChatGPT: \`${displayProjectLabel}\`).`,
    '- Nếu trên ChatGPT chưa có Project trùng tên thư mục dự án Antigravity, hệ thống sẽ **tự động tạo Project mới** ngay khi kết nối Chrome (cổng `9222`).',
    '- Đã kích hoạt Git Pre-commit Hook tại `.agents/hooks/pre-commit`.',
    '',
    '## 2. Bước tiếp theo (Next Steps)',
    '1. Thống nhất yêu cầu sản phẩm và cập nhật danh sách Task thực tế vào `.agents/state/ROADMAP.md`.',
    '2. Lập kế hoạch thiết kế chi tiết cho `Task 1` vào `.agents/state/CURRENT_PLAN.md`.',
    '3. Gửi Mentor duyệt kế hoạch: `node .agents/scripts/ask_mentor.mjs --mode plan --task task-1 --provider both` (hoặc `--provider chatgpt`).',
    '',
  ].join('\n');

  const sessionMapTemplate = {
    projectName: resolvedProjectName,
    projectUrl: 'https://chatgpt.com/',
    geminiThreadUrl: '',
    currentTask: 'task-1',
    threads: {},
    geminiThreads: {},
    stageRounds: {},
  };

  const stateLockTemplate = {
    taskId: 'task-1',
    planHash: '',
    codeDiffHash: '',
    updatedAt: templateMode ? '' : new Date().toISOString(),
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
  console.log('[INIT]: Đã đặt lại toàn bộ các file trạng thái chuẩn v2 trong .agents/state/.');

  // 3. Nếu có cờ --clean-demo: xóa các file demo cũ (nếu còn) và đảm bảo src/, tests/ rỗng sạch
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
  }

  ensureSourceDirsReady(nextConfig.sourceDirs || ['src', 'tests']);

  // 4. Tự động kiểm tra / tạo Project trên ChatGPT trùng tên dự án Antigravity (khi không ở chế độ --template / --offline)
  if (!templateMode && !offline) {
    console.log(
      `[INIT]: Đang kiểm tra / tự động tạo Project "${resolvedProjectName}" trên ChatGPT (cổng 9222)...`
    );
    const syncRes = childProcess.spawnSync(
      process.execPath,
      [ASK_MENTOR_SCRIPT, '--ensure-project', '--project-name', resolvedProjectName],
      { cwd: REPO_ROOT, stdio: 'inherit' }
    );
    if (syncRes.status !== 0) {
      console.log(
        `[INIT NOTE]: Chưa kết nối ngay tới Chrome (9222) — Project "${resolvedProjectName}" sẽ được TỰ ĐỘNG TẠO trên ChatGPT ngay ở lần chạy ask_mentor.mjs đầu tiên!`
      );
    }
  }

  console.log(
    templateMode
      ? '[INIT TEMPLATE HOÀN TẤT]: Bộ khung Starter Template đã sạch sẽ và sẵn sàng đóng gói lên Git!'
      : `[INIT HOÀN TẤT]: Dự án "${resolvedProjectName}" đã sẵn sàng!`
  );
}

main();

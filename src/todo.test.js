#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

const todoModule = require('./todo');
const {
  VALID_FILTERS, resolveStoragePath, isValidIsoTimestamp, parseTaskId,
  validateTaskList, loadTasks, saveTasks, addTask, listTasks,
  completeTask, removeTask, deleteTask, runCli,
} = todoModule;

const TODO_MODULE_PATH = path.resolve(__dirname, 'todo.js');

function createBaseValidTask(overrides = {}) {
  return {
    id: 1, title: 'Công việc mẫu hợp lệ', completed: false,
    createdAt: '2026-11-06T20:40:00.000Z', completedAt: null, ...overrides,
  };
}

function isInsideDir(targetPath, parentDir) {
  if (typeof targetPath !== 'string' || typeof parentDir !== 'string') return false;
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function withTempWorkspace(fn, rmSyncImpl = fs.rmSync) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'));
  const filePath = path.join(tempDir, 'tasks.json');
  let testError = null;
  let result;
  try {
    result = fn({ tempDir, filePath });
  } catch (err) {
    testError = err;
  }
  let cleanupError = null;
  try {
    rmSyncImpl(tempDir, { recursive: true, force: true });
    if (fs.existsSync(tempDir)) throw new Error(`Thư mục tạm vẫn còn tồn tại: ${tempDir}`);
  } catch (err) {
    cleanupError = new Error(`[Cleanup Failure tại ${tempDir}]: ${err && err.message ? err.message : String(err)}`);
  }
  if (testError && cleanupError) {
    testError.cleanupError = cleanupError;
    testError.message = `${testError.message}\n  [Lỗi Cleanup kèm theo]: ${cleanupError.message}`;
    throw testError;
  }
  if (testError) throw testError;
  if (cleanupError) throw cleanupError;
  return result;
}

function captureCliExecution(fn) {
  const prevLog = console.log;
  const prevError = console.error;
  const prevExitCode = process.exitCode;
  const stdoutLines = [];
  const stderrLines = [];
  console.log = (...args) => stdoutLines.push(args.map(String).join(' '));
  console.error = (...args) => stderrLines.push(args.map(String).join(' '));
  process.exitCode = undefined;
  let returnValue;
  let exitCodeAfter;
  try {
    returnValue = fn();
    exitCodeAfter = process.exitCode;
  } finally {
    console.log = prevLog;
    console.error = prevError;
    process.exitCode = prevExitCode;
  }
  return {
    returnValue, exitCodeAfter, stdoutLines, stderrLines,
    stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n'),
  };
}

function runTestSuite(tests, options = {}) {
  const silent = options.silent === true;
  const setExitCode = options.setExitCode !== false;
  const total = tests.length;
  let executed = 0, passed = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < tests.length; i += 1) {
    const testCase = tests[i];
    executed += 1;
    try {
      testCase.fn();
      passed += 1;
      if (!silent) console.log(`[PASS] ${testCase.name}`);
    } catch (err) {
      failed += 1;
      const message = err && err.message ? err.message : String(err);
      const stack = err && err.stack ? err.stack : message;
      failures.push({ name: testCase.name, error: err, message, stack });
      if (!silent) console.error(`[FAIL] ${testCase.name}: ${message}`);
    }
  }

  assert.strictEqual(executed, total, `executed (${executed}) !== total (${total})`);
  assert.strictEqual(passed + failed, total, `passed + failed (${passed + failed}) !== total (${total})`);
  const exitCode = failed > 0 ? 1 : 0;
  if (!silent) {
    console.log(`\n=== TỔNG KẾT: ${passed}/${total} PASS | ${failed}/${total} FAIL (Executed: ${executed}) ===`);
    for (const f of failures) console.error(`- ${f.name}:\n  ${f.stack}`);
  }
  if (setExitCode && exitCode !== 0) process.exitCode = exitCode;
  return { total, executed, passed, failed, failures, exitCode };
}

const testCases = [
  {
    name: 'T1.1 — Kiểm tra tập hằng số VALID_FILTERS và toàn bộ 13 thành phần export',
    fn: () => {
      assert.ok(VALID_FILTERS instanceof Set);
      assert.deepStrictEqual([...VALID_FILTERS].sort(), ['all', 'completed', 'pending']);
      const fnNames = [
        'resolveStoragePath', 'isValidIsoTimestamp', 'parseTaskId', 'validateTaskList',
        'loadTasks', 'saveTasks', 'addTask', 'listTasks', 'completeTask', 'removeTask', 'deleteTask', 'runCli',
      ];
      for (const name of fnNames) assert.strictEqual(typeof todoModule[name], 'function', name);
      assert.strictEqual(deleteTask, removeTask);
      assert.strictEqual(Object.keys(todoModule).length, 13);
    },
  },
  {
    name: 'T1.2 — Thứ tự ưu tiên của resolveStoragePath(customPath, env, cwd)',
    fn: () => {
      const hadEnv = Object.prototype.hasOwnProperty.call(process.env, 'TODO_FILE');
      const origEnv = process.env.TODO_FILE;
      try {
        process.env.TODO_FILE = '  ./env-dir/env.json  ';
        assert.strictEqual(resolveStoragePath('  ./custom/c.json  '), path.resolve('./custom/c.json'));
        assert.strictEqual(resolveStoragePath(), path.resolve('./env-dir/env.json'));
        assert.strictEqual(resolveStoragePath('   '), path.resolve('./env-dir/env.json'));
        delete process.env.TODO_FILE;
        assert.strictEqual(resolveStoragePath(), path.resolve(process.cwd(), 'tasks.json'));
        process.env.TODO_FILE = '   ';
        assert.strictEqual(resolveStoragePath(''), path.resolve(process.cwd(), 'tasks.json'));
      } finally {
        if (hadEnv) process.env.TODO_FILE = origEnv;
        else delete process.env.TODO_FILE;
      }
    },
  },
  {
    name: 'T1.3 — Chu trình CRUD cơ bản (addTask, listTasks, completeTask, removeTask/deleteTask)',
    fn: () => withTempWorkspace(({ filePath }) => {
      assert.deepStrictEqual(loadTasks(filePath), []);
      assert.deepStrictEqual(listTasks('all', filePath), []);
      assert.strictEqual(fs.existsSync(filePath), false);

      const t1 = addTask('  Viết báo cáo kiến trúc  ', filePath);
      const t2 = addTask('Họp nhóm review', filePath);
      assert.strictEqual(t1.id, 1);
      assert.strictEqual(t1.title, 'Viết báo cáo kiến trúc');
      assert.strictEqual(t1.completed, false);
      assert.strictEqual(isValidIsoTimestamp(t1.createdAt), true);
      assert.strictEqual(t1.completedAt, null);
      assert.strictEqual(t2.id, 2);

      const beforeBadAdd = fs.readFileSync(filePath);
      for (const badTitle of ['', '   \t\n ', null, undefined, 123, {}, []]) {
        assert.throws(() => addTask(badTitle, filePath), /Tiêu đề công việc không được để trống/);
        assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), beforeBadAdd), 0);
      }

      const done1 = completeTask(1, filePath);
      assert.strictEqual(done1.completed, true);
      assert.ok(Date.parse(done1.completedAt) >= Date.parse(done1.createdAt));
      assert.strictEqual(listTasks(undefined, filePath).length, 2);
      assert.strictEqual(listTasks('all', filePath).length, 2);
      assert.deepStrictEqual(listTasks('pending', filePath).map((t) => t.id), [2]);
      assert.deepStrictEqual(listTasks('completed', filePath).map((t) => t.id), [1]);

      assert.strictEqual(removeTask(1, filePath).id, 1);
      assert.strictEqual(deleteTask('2', filePath).id, 2);
      assert.deepStrictEqual(listTasks('all', filePath), []);
    }),
  },
  {
    name: 'T1.4 — Kiểm tra bộ lọc không hợp lệ của listTasks() và kiểm thử trực tiếp validateTaskList() / saveTasks() (Lưu ý 01)',
    fn: () => withTempWorkspace(({ filePath }) => {
      for (const badFilter of ['invalid', 'done', 'active', '', null, 123, {}]) {
        assert.throws(() => listTasks(badFilter, filePath), /Bộ lọc không hợp lệ/);
      }
      assert.doesNotThrow(() => validateTaskList([]));
      assert.doesNotThrow(() => validateTaskList([
        createBaseValidTask({ id: 1 }),
        createBaseValidTask({ id: 2, completed: true, completedAt: '2026-11-06T20:45:00.000Z' }),
      ]));
      assert.throws(() => validateTaskList(null), /gốc JSON phải là một mảng/);
      assert.throws(() => validateTaskList([null]), /phải là một đối tượng/);
      assert.throws(() => validateTaskList([createBaseValidTask({ id: 0 })]), /id phải là số nguyên dương an toàn/);
      assert.throws(() => validateTaskList([createBaseValidTask({ id: 1 }), createBaseValidTask({ id: 1 })]), /trùng lặp ID 1/);
      assert.throws(() => validateTaskList([createBaseValidTask({ title: '  ' })]), /title phải là chuỗi khác rỗng/);
      assert.throws(() => validateTaskList([createBaseValidTask({ completed: 'true' })]), /completed phải là kiểu boolean/);
      assert.throws(() => validateTaskList([createBaseValidTask({ createdAt: '2026-02-30T00:00:00.000Z' })]), /createdAt không đúng chuẩn ISO 8601/);
      assert.throws(() => validateTaskList([createBaseValidTask({ completed: false, completedAt: '2026-11-06T20:40:00.000Z' })]), /completedAt phải là null khi chưa hoàn thành/);
      assert.throws(() => validateTaskList([createBaseValidTask({ completed: true, completedAt: null })]), /completedAt phải là chuỗi ISO 8601 hợp lệ khi đã hoàn thành/);
      assert.throws(() => validateTaskList([createBaseValidTask({ completed: true, completedAt: '2026-11-06T20:39:00.000Z' })]), /completedAt không được nhỏ hơn createdAt/);

      const validArr = [createBaseValidTask({ id: 1, title: 'Direct Save' })];
      saveTasks(validArr, filePath);
      const savedBuf = fs.readFileSync(filePath);
      assert.strictEqual(savedBuf.toString('utf8'), `${JSON.stringify(validArr, null, 2)}\n`);
      assert.throws(() => saveTasks([createBaseValidTask({ id: -1 })], filePath), /id phải là số nguyên dương an toàn/);
      assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), savedBuf), 0);
    }),
  },
  {
    name: 'T2.1 — Xóa phần tử ở giữa danh sách không tái sử dụng ID bị khuyết ở giữa',
    fn: () => withTempWorkspace(({ filePath }) => {
      addTask('T1', filePath); addTask('T2', filePath); addTask('T3', filePath);
      removeTask(2, filePath);
      const t4 = addTask('T4', filePath);
      assert.strictEqual(t4.id, 4);
      assert.deepStrictEqual(listTasks('all', filePath).map((t) => t.id), [1, 3, 4]);
    }),
  },
  {
    name: 'T2.2 — Xóa phần tử có ID lớn nhất ở cuối sẽ tái sử dụng lại ID lớn nhất đó',
    fn: () => withTempWorkspace(({ filePath }) => {
      addTask('T1', filePath); addTask('T2', filePath); addTask('T3', filePath);
      removeTask(3, filePath);
      const reused = addTask('T3 Reused', filePath);
      assert.strictEqual(reused.id, 3);
      assert.deepStrictEqual(listTasks('all', filePath).map((t) => t.id), [1, 2, 3]);
    }),
  },
  {
    name: 'T2.3 — Xóa toàn bộ danh sách sẽ reset ID của task mới tiếp theo về 1',
    fn: () => withTempWorkspace(({ filePath }) => {
      addTask('T1', filePath); addTask('T2', filePath);
      removeTask(1, filePath); removeTask(2, filePath);
      assert.strictEqual(addTask('Reset', filePath).id, 1);
    }),
  },
  {
    name: 'T2.4 — Chặn tràn số nguyên an toàn khi maxId đạt Number.MAX_SAFE_INTEGER',
    fn: () => withTempWorkspace(({ filePath }) => {
      saveTasks([createBaseValidTask({ id: Number.MAX_SAFE_INTEGER })], filePath);
      const beforeBuf = fs.readFileSync(filePath);
      assert.throws(() => addTask('Overflow', filePath), /vượt quá giới hạn số nguyên an toàn/);
      assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), beforeBuf), 0);
    }),
  },
  {
    name: 'T3.1 — Kiểm thử đơn vị hàm isValidIsoTimestamp() với các trường hợp biên ngày lịch, giờ và offset',
    fn: () => {
      const validList = [
        '2026-11-06T20:40:00.000Z', '2026-11-06T20:40:00Z', '2026-11-06T20:40:00.123456789Z',
        '2026-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-11-06T20:40:00+07:00',
        '2026-11-06T00:00:00+00:00', '2026-06-15T12:30:00+23:59', '2026-06-15T12:30:00-23:59',
        '2026-04-30T23:59:59-05:30', '2024-02-29T12:00:00.000Z', '2000-02-29T00:00:00.000Z',
      ];
      for (const ts of validList) assert.strictEqual(isValidIsoTimestamp(ts), true, ts);
      const invalidList = [
        '2026-02-30T00:00:00.000Z', '2025-02-29T00:00:00.000Z', '1900-02-29T00:00:00.000Z',
        '2026-04-31T00:00:00.000Z', '2026-06-31T00:00:00.000Z', '2026-09-31T00:00:00.000Z',
        '2026-11-31T00:00:00.000Z', '2026-00-15T00:00:00.000Z', '2026-13-01T00:00:00.000Z',
        '2026-01-00T00:00:00.000Z', '2026-01-32T00:00:00.000Z', '2026-11-06T24:00:00.000Z',
        '2026-11-06T23:60:00.000Z', '2026-11-06T23:59:60.000Z', '2026-11-06T10:00:00+24:00',
        '2026-11-06T10:00:00-24:00', '2026-11-06T10:00:00+00:60', '2026-11-06T10:00:00-05:60',
        '2026-11-06', '2026-11-06T20:40:00', '', '   ', 1700000000000, null, undefined, {}, [], new Date(),
      ];
      for (const badTs of invalidList) assert.strictEqual(isValidIsoTimestamp(badTs), false, String(badTs));
    },
  },
  {
    name: 'T3.2 — Bảo toàn nguyên vẹn Byte-for-Byte (Buffer.compare) với các mẫu dữ liệu lỗi đơn biến (Single-Fault Mutation)',
    fn: () => withTempWorkspace(({ filePath }) => {
      const cases = [
        { payload: '', regex: /rỗng hoặc hỏng/ },
        { payload: '   \n\t  ', regex: /rỗng hoặc hỏng/ },
        { payload: '[{"id": 1, "title": "Broken"', regex: /hỏng hoặc sai cú pháp/ },
        { payload: '{"id": 1}', regex: /gốc JSON phải là một mảng/ },
        { payload: '[null]', regex: /phải là một đối tượng/ },
        { payload: '[[1]]', regex: /phải là một đối tượng/ },
        { payload: '["str"]', regex: /phải là một đối tượng/ },
        { payload: JSON.stringify([createBaseValidTask({ id: 0 })]), regex: /id phải là số nguyên dương an toàn/ },
        { payload: JSON.stringify([createBaseValidTask({ id: -1 })]), regex: /id phải là số nguyên dương an toàn/ },
        { payload: JSON.stringify([createBaseValidTask({ id: 1.5 })]), regex: /id phải là số nguyên dương an toàn/ },
        { payload: JSON.stringify([createBaseValidTask({ id: '1' })]), regex: /id phải là số nguyên dương an toàn/ },
        { payload: JSON.stringify([createBaseValidTask({ id: 1 }), createBaseValidTask({ id: 1, title: 'Dup' })]), regex: /trùng lặp ID 1/ },
        { payload: JSON.stringify([createBaseValidTask({ title: '' })]), regex: /title phải là chuỗi khác rỗng/ },
        { payload: JSON.stringify([createBaseValidTask({ title: '   ' })]), regex: /title phải là chuỗi khác rỗng/ },
        { payload: JSON.stringify([createBaseValidTask({ title: 123 })]), regex: /title phải là chuỗi khác rỗng/ },
        { payload: JSON.stringify([createBaseValidTask({ completed: 'false' })]), regex: /completed phải là kiểu boolean/ },
        { payload: JSON.stringify([createBaseValidTask({ completed: 0 })]), regex: /completed phải là kiểu boolean/ },
        { payload: JSON.stringify([createBaseValidTask({ createdAt: '2026-02-30T00:00:00.000Z' })]), regex: /createdAt không đúng chuẩn ISO 8601/ },
        { payload: JSON.stringify([createBaseValidTask({ completed: false, completedAt: '2026-11-06T20:40:00.000Z' })]), regex: /completedAt phải là null khi chưa hoàn thành/ },
        { payload: JSON.stringify([createBaseValidTask({ completed: true, completedAt: null })]), regex: /completedAt phải là chuỗi ISO 8601 hợp lệ khi đã hoàn thành/ },
        { payload: JSON.stringify([createBaseValidTask({ completed: true, completedAt: '2025-02-29T00:00:00.000Z' })]), regex: /completedAt phải là chuỗi ISO 8601 hợp lệ khi đã hoàn thành/ },
        { payload: JSON.stringify([createBaseValidTask({ completed: true, createdAt: '2026-11-06T20:40:00.000Z', completedAt: '2026-11-06T20:39:59.999Z' })]), regex: /completedAt không được nhỏ hơn createdAt/ },
      ];
      for (const { payload, regex } of cases) {
        fs.writeFileSync(filePath, payload, 'utf8');
        const beforeBuffer = fs.readFileSync(filePath);
        assert.throws(() => loadTasks(filePath), regex);
        assert.throws(() => listTasks('all', filePath), regex);
        assert.throws(() => addTask('Task mới', filePath), regex);
        assert.throws(() => completeTask(1, filePath), regex);
        assert.throws(() => removeTask(1, filePath), regex);
        assert.strictEqual(Buffer.compare(beforeBuffer, fs.readFileSync(filePath)), 0);
      }
    }),
  },
  {
    name: 'T4.1 — completeTask() lũy đẳng: giữ nguyên completedAt, giữ nguyên Buffer file và không kích hoạt bất kỳ thao tác ghi đĩa nào ở lần 2',
    fn: () => withTempWorkspace(({ tempDir, filePath }) => {
      const created = addTask('Kiểm tra tính lũy đẳng', filePath);
      const firstDone = completeTask(created.id, filePath);
      assert.strictEqual(firstDone.completed, true);
      const beforeBuffer = fs.readFileSync(filePath);

      const orig = {
        writeFileSync: fs.writeFileSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync,
        mkdirSync: fs.mkdirSync, appendFileSync: fs.appendFileSync, openSync: fs.openSync,
      };
      let writeAttemptCount = 0;
      const guardPath = (target) => {
        if (isInsideDir(String(target), tempDir)) {
          writeAttemptCount += 1;
          throw new Error(`Vi phạm Idempotency: completeTask lần 2 đã cố ghi vào ${target}`);
        }
      };
      fs.writeFileSync = function (file, ...rest) { guardPath(file); return orig.writeFileSync.call(this, file, ...rest); };
      fs.renameSync = function (oldP, newP) { guardPath(oldP); guardPath(newP); return orig.renameSync.call(this, oldP, newP); };
      fs.unlinkSync = function (target) { guardPath(target); return orig.unlinkSync.call(this, target); };
      fs.mkdirSync = function (target, ...rest) { guardPath(target); return orig.mkdirSync.call(this, target, ...rest); };
      fs.appendFileSync = function (target, ...rest) { guardPath(target); return orig.appendFileSync.call(this, target, ...rest); };
      fs.openSync = function (target, flags, ...rest) {
        if (typeof flags === 'string' && /[wa+]/.test(flags)) guardPath(target);
        return orig.openSync.call(this, target, flags, ...rest);
      };

      let secondDone;
      try {
        secondDone = completeTask(created.id, filePath);
      } finally {
        Object.assign(fs, orig);
      }
      assert.strictEqual(writeAttemptCount, 0);
      assert.strictEqual(secondDone.completed, true);
      assert.strictEqual(secondDone.completedAt, firstDone.completedAt);
      assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), beforeBuffer), 0);
      assert.deepStrictEqual(fs.readdirSync(tempDir), ['tasks.json']);
    }),
  },
  {
    name: 'T5.1 — Clock-Rollback Consistency: completeTask() đảm bảo completedAt >= createdAt khi Date.now() bị lùi về quá khứ',
    fn: () => withTempWorkspace(({ filePath }) => {
      const task = addTask('Kiểm tra lùi đồng hồ', filePath);
      const createdMs = Date.parse(task.createdAt);
      const originalDateNow = Date.now;
      try {
        Date.now = () => createdMs - 60_000;
        const completedTask = completeTask(task.id, filePath);
        assert.strictEqual(completedTask.completed, true);
        assert.strictEqual(completedTask.completedAt, task.createdAt);
        const reloaded = loadTasks(filePath);
        assert.strictEqual(reloaded[0].completedAt, task.createdAt);
      } finally {
        Date.now = originalDateNow;
      }
    }),
  },
  {
    name: 'T6.1 — Kiểm thử toàn diện parseTaskId() với các đầu vào hợp lệ và bất hợp lệ',
    fn: () => {
      assert.strictEqual(parseTaskId(1), 1);
      assert.strictEqual(parseTaskId('42'), 42);
      assert.strictEqual(parseTaskId(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
      assert.strictEqual(parseTaskId(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
      const invalidIds = [
        true, false, '1e0', '1e5', '0x1', '0b1', '0o1', '01', '007', '+1', ' 1', '1 ',
        0, -0, -1, '0', '-1', 1.5, '1.5', NaN, Infinity, -Infinity,
        Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '', '   ', null, undefined, {}, [], [1],
      ];
      for (const rawId of invalidIds) assert.throws(() => parseTaskId(rawId), /ID công việc không hợp lệ/);
    },
  },
  {
    name: 'T6.2 — completeTask() và removeTask() từ chối ID lỗi hoặc không tồn tại và giữ nguyên file từng byte',
    fn: () => withTempWorkspace(({ filePath }) => {
      addTask('Task duy nhất', filePath);
      const beforeBuffer = fs.readFileSync(filePath);
      for (const badId of [true, false, '1e0', '0x1', '01', 0, -5, 1.5, null, '']) {
        assert.throws(() => completeTask(badId, filePath), /ID công việc không hợp lệ/);
        assert.throws(() => removeTask(badId, filePath), /ID công việc không hợp lệ/);
        assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), beforeBuffer), 0);
      }
      assert.throws(() => completeTask(999, filePath), /Không tìm thấy công việc với ID 999/);
      assert.throws(() => removeTask(999, filePath), /Không tìm thấy công việc với ID 999/);
      assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), beforeBuffer), 0);
    }),
  },
  {
    name: 'T7.1 — Kiểm chứng tính an toàn khi import require("./todo") bằng tiến trình con độc lập (BLOCKER 01 & Lưu ý 02)',
    fn: () => withTempWorkspace(({ tempDir, filePath }) => {
      saveTasks([createBaseValidTask({ id: 1, title: 'Sentinel Task' })], filePath);
      const sentinelBuffer = fs.readFileSync(filePath);
      const childEnv = { ...process.env };
      delete childEnv.TODO_FILE;
      childEnv.TARGET_TODO_MODULE = TODO_MODULE_PATH;
      const probeScript = [
        'const mod = require(process.env.TARGET_TODO_MODULE);',
        'if (process.exitCode !== undefined) { process.exit(2); }',
        'if (typeof mod.addTask !== "function" || typeof mod.runCli !== "function") { process.exit(3); }',
      ].join(' ');
      const res = childProcess.spawnSync(process.execPath, ['-e', probeScript], {
        cwd: tempDir, env: childEnv, encoding: 'utf8', timeout: 10_000,
      });
      assert.strictEqual(res.error, undefined);
      assert.strictEqual(res.signal, null);
      assert.strictEqual(res.status, 0);
      assert.strictEqual(res.stdout, '');
      assert.strictEqual(res.stderr, '');
      assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), sentinelBuffer), 0);
      assert.deepStrictEqual(fs.readdirSync(tempDir), ['tasks.json']);
    }),
  },
  {
    name: 'T7.2 — Kiểm thử trực tiếp runCli(args, filePath) và hợp đồng process.exitCode (BLOCKER 02)',
    fn: () => withTempWorkspace(({ filePath }) => {
      for (const helpArg of ['help', '--help', '-h']) {
        const res = captureCliExecution(() => runCli([helpArg], filePath));
        assert.strictEqual(res.returnValue, 0);
        assert.strictEqual(res.exitCodeAfter, undefined);
        assert.ok(res.stdout.includes('Cách sử dụng:'));
      }
      const emptyRes = captureCliExecution(() => runCli(['list'], filePath));
      assert.strictEqual(emptyRes.returnValue, 0);
      assert.strictEqual(emptyRes.exitCodeAfter, undefined);
      assert.strictEqual(emptyRes.stdout, 'Danh sách công việc trống.');

      const add1 = captureCliExecution(() => runCli(['add', 'Mua', 'sách', 'Node.js'], filePath));
      assert.strictEqual(add1.returnValue, 0);
      assert.strictEqual(add1.exitCodeAfter, undefined);
      assert.strictEqual(add1.stdout, 'Đã thêm công việc #1: "Mua sách Node.js"');
      captureCliExecution(() => runCli(['add', 'Viết', 'unit', 'test'], filePath));

      const done1 = captureCliExecution(() => runCli(['done', '1'], filePath));
      assert.strictEqual(done1.returnValue, 0);
      assert.strictEqual(done1.exitCodeAfter, undefined);

      for (const allArgs of [['list'], ['list', 'all'], ['list', '--all']]) {
        const r = captureCliExecution(() => runCli(allArgs, filePath));
        assert.strictEqual(r.returnValue, 0);
        assert.strictEqual(r.exitCodeAfter, undefined);
        assert.ok(r.stdout.includes('[x] #1: Mua sách Node.js') && r.stdout.includes('[ ] #2: Viết unit test'));
      }
      for (const pArgs of [['list', 'pending'], ['list', '--pending']]) {
        const r = captureCliExecution(() => runCli(pArgs, filePath));
        assert.strictEqual(r.returnValue, 0);
        assert.strictEqual(r.stdout, '[ ] #2: Viết unit test');
      }
      for (const cArgs of [['list', 'completed'], ['list', '--completed']]) {
        const r = captureCliExecution(() => runCli(cArgs, filePath));
        assert.strictEqual(r.returnValue, 0);
        assert.strictEqual(r.stdout, '[x] #1: Mua sách Node.js');
      }
      assert.strictEqual(captureCliExecution(() => runCli(['complete', '2'], filePath)).returnValue, 0);
      assert.strictEqual(captureCliExecution(() => runCli(['remove', '1'], filePath)).returnValue, 0);
      assert.strictEqual(captureCliExecution(() => runCli(['delete', '2'], filePath)).returnValue, 0);

      const badCliCases = [
        [], ['unknown-cmd'], ['add'], ['add', '   '], ['list', 'all', 'extra'],
        ['list', 'invalid'], ['list', '--invalid'], ['done'], ['done', '1', '2'],
        ['done', '01'], ['done', '999'], ['complete'], ['remove'], ['delete', '1', '2'], ['remove', '1e0'], ['remove', '999'],
      ];
      for (const badArgs of badCliCases) {
        const errRes = captureCliExecution(() => runCli(badArgs, filePath));
        assert.strictEqual(errRes.returnValue, 1);
        assert.strictEqual(errRes.exitCodeAfter, 1);
        assert.ok(errRes.stderr.includes('Lỗi:'));
      }
    }),
  },
  {
    name: 'T7.3 — Kiểm thử tích hợp CLI End-to-End qua tiến trình con child_process.spawnSync',
    fn: () => withTempWorkspace(({ tempDir, filePath }) => {
      const execCli = (args) => {
        const res = childProcess.spawnSync(process.execPath, [TODO_MODULE_PATH, ...args], {
          cwd: tempDir, env: { ...process.env, TODO_FILE: filePath }, encoding: 'utf8', timeout: 10_000,
        });
        assert.strictEqual(res.error, undefined);
        assert.strictEqual(res.signal, null);
        return res;
      };
      assert.strictEqual(execCli(['add', 'Subprocess Task']).status, 0);
      assert.strictEqual(execCli(['list', '--pending']).stdout.trim(), '[ ] #1: Subprocess Task');
      assert.strictEqual(execCli(['done', '1']).status, 0);
      assert.strictEqual(execCli(['list', '--completed']).stdout.trim(), '[x] #1: Subprocess Task');
      assert.strictEqual(execCli(['delete', '1']).status, 0);
      const rFail = execCli(['done', '0x1']);
      assert.strictEqual(rFail.status, 1);
      assert.ok(rFail.stderr.includes('Lỗi:'));
    }),
  },
  {
    name: 'T8.1 — Tạo thư mục cha đệ quy và xác minh không còn sót bất kỳ file tạm nào theo quy ước của saveTasks()',
    fn: () => withTempWorkspace(({ tempDir }) => {
      const nestedDir = path.join(tempDir, 'nested', 'deep', 'storage');
      const nestedFilePath = path.join(nestedDir, 'tasks.json');
      assert.strictEqual(addTask('Nested Task', nestedFilePath).id, 1);
      const entries = fs.readdirSync(nestedDir);
      assert.deepStrictEqual(entries, ['tasks.json']);
      const leftover = entries.filter((n) => n.endsWith('.tmp') || n.startsWith(`.${path.basename(nestedFilePath)}.`));
      assert.strictEqual(leftover.length, 0);
    }),
  },
  {
    name: 'T8.2 — Scoped Fault Injection khi fs.renameSync thất bại (EACCES/EXDEV): bảo toàn lỗi gốc, xóa file .tmp và giữ nguyên file gốc',
    fn: () => withTempWorkspace(({ tempDir, filePath }) => {
      addTask('Task ban đầu an toàn', filePath);
      const beforeBuffer = fs.readFileSync(filePath);
      const originalRenameSync = fs.renameSync;
      try {
        fs.renameSync = function scopedMockRenameSync(oldPath, newPath) {
          if (isInsideDir(String(oldPath), tempDir) || isInsideDir(String(newPath), tempDir)) {
            assert.strictEqual(fs.existsSync(String(oldPath)), true);
            const err = new Error('Simulated renameSync EXDEV/EACCES failure');
            err.code = 'EACCES';
            throw err;
          }
          return originalRenameSync.call(this, oldPath, newPath);
        };
        assert.throws(
          () => addTask('Task lỗi khi rename', filePath),
          (err) => err instanceof Error && err.code === 'EACCES' && err.message === 'Simulated renameSync EXDEV/EACCES failure'
        );
      } finally {
        fs.renameSync = originalRenameSync;
      }
      assert.deepStrictEqual(fs.readdirSync(tempDir), ['tasks.json']);
      assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), beforeBuffer), 0);
    }),
  },
  {
    name: 'T8.3 — Scoped Fault Injection khi fs.writeFileSync thất bại (ngay lập tức & ghi dở một phần — Lưu ý 03): dọn sạch .tmp và bảo toàn file gốc',
    fn: () => withTempWorkspace(({ tempDir, filePath }) => {
      addTask('Task gốc trước khi lỗi ghi', filePath);
      const beforeBuffer = fs.readFileSync(filePath);
      const originalWriteFileSync = fs.writeFileSync;

      try {
        fs.writeFileSync = function scopedImmediateFail(target, ...rest) {
          if (isInsideDir(String(target), tempDir)) {
            const err = new Error('Simulated immediate ENOSPC disk full');
            err.code = 'ENOSPC';
            throw err;
          }
          return originalWriteFileSync.call(this, target, ...rest);
        };
        assert.throws(
          () => addTask('Task lỗi ghi ngay', filePath),
          (err) => err instanceof Error && err.code === 'ENOSPC' && err.message === 'Simulated immediate ENOSPC disk full'
        );
      } finally {
        fs.writeFileSync = originalWriteFileSync;
      }
      assert.deepStrictEqual(fs.readdirSync(tempDir), ['tasks.json']);
      assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), beforeBuffer), 0);

      try {
        fs.writeFileSync = function scopedPartialFail(target, data, options) {
          if (isInsideDir(String(target), tempDir)) {
            originalWriteFileSync.call(this, target, String(data).slice(0, 12), options);
            assert.strictEqual(fs.existsSync(target), true);
            const err = new Error('Simulated partial write ENOSPC failure');
            err.code = 'ENOSPC';
            throw err;
          }
          return originalWriteFileSync.call(this, target, data, options);
        };
        assert.throws(
          () => addTask('Task lỗi ghi dở', filePath),
          (err) => err instanceof Error && err.code === 'ENOSPC' && err.message === 'Simulated partial write ENOSPC failure'
        );
      } finally {
        fs.writeFileSync = originalWriteFileSync;
      }
      assert.deepStrictEqual(fs.readdirSync(tempDir), ['tasks.json']);
      assert.strictEqual(Buffer.compare(fs.readFileSync(filePath), beforeBuffer), 0);
    }),
  },
  {
    name: 'T9.1 — Tự kiểm chứng runTestSuite ở cả đường thành công, đường thất bại, khôi phục mock và kiểm chứng Exit Code cấp tiến trình (Lưu ý 04)',
    fn: () => {
      const passSuite = runTestSuite([
        { name: 'Pass 1', fn: () => assert.strictEqual(1 + 1, 2) },
        { name: 'Pass 2', fn: () => assert.ok(true) },
      ], { silent: true, setExitCode: false });
      assert.strictEqual(passSuite.total, 2);
      assert.strictEqual(passSuite.executed, 2);
      assert.strictEqual(passSuite.passed, 2);
      assert.strictEqual(passSuite.failed, 0);
      assert.strictEqual(passSuite.exitCode, 0);

      let mockFlag = 'restored';
      const failSuite = runTestSuite([
        { name: 'Step 1 Pass', fn: () => assert.strictEqual(mockFlag, 'restored') },
        {
          name: 'Step 2 Intentional Fail',
          fn: () => {
            mockFlag = 'mutated';
            try { assert.fail('Intentional assertion failure for runner check'); }
            finally { mockFlag = 'restored'; }
          },
        },
        { name: 'Step 3 Verify Restoration', fn: () => assert.strictEqual(mockFlag, 'restored') },
      ], { silent: true, setExitCode: false });
      assert.strictEqual(failSuite.total, 3);
      assert.strictEqual(failSuite.executed, 3);
      assert.strictEqual(failSuite.passed, 2);
      assert.strictEqual(failSuite.failed, 1);
      assert.strictEqual(failSuite.exitCode, 1);
      assert.strictEqual(failSuite.failures[0].name, 'Step 2 Intentional Fail');
      assert.strictEqual(mockFlag, 'restored');

      const childRes = childProcess.spawnSync(process.execPath, [__filename, '--simulate-runner-failure'], {
        encoding: 'utf8', timeout: 10_000,
      });
      assert.strictEqual(childRes.error, undefined);
      assert.strictEqual(childRes.signal, null);
      assert.strictEqual(childRes.status, 1);
      assert.ok(childRes.stderr.includes('[FAIL] Simulated Failing Test'));
    },
  },
  {
    name: 'T9.2 — Tự kiểm chứng cơ chế xử lý lỗi Cleanup của withTempWorkspace (BLOCKER 04)',
    fn: () => {
      assert.throws(
        () => withTempWorkspace(
          ({ tempDir }) => assert.strictEqual(fs.existsSync(tempDir), true),
          (targetDir, opts) => { fs.rmSync(targetDir, opts); throw new Error('Simulated rmSync permission error'); }
        ),
        (err) => err instanceof Error && err.message.includes('[Cleanup Failure') && err.message.includes('Simulated rmSync permission error')
      );
      assert.throws(
        () => withTempWorkspace(
          () => { throw new Error('Original primary test assertion error'); },
          (targetDir, opts) => { fs.rmSync(targetDir, opts); throw new Error('Secondary cleanup failure'); }
        ),
        (err) =>
          err instanceof Error &&
          err.message.startsWith('Original primary test assertion error') &&
          err.message.includes('[Lỗi Cleanup kèm theo]') &&
          err.cleanupError instanceof Error
      );
    },
  },
];

if (require.main === module) {
  if (process.argv.includes('--simulate-runner-failure')) {
    runTestSuite([
      { name: 'Simulated Passing Test', fn: () => assert.strictEqual(1, 1) },
      { name: 'Simulated Failing Test', fn: () => assert.fail('Simulated failure for process exit code check') },
    ], { silent: false, setExitCode: true });
  } else {
    runTestSuite(testCases, { silent: false, setExitCode: true });
  }
}

module.exports = { isInsideDir, withTempWorkspace, captureCliExecution, runTestSuite, testCases };

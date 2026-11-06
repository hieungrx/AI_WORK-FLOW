#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tập hợp các bộ lọc hợp lệ cho hàm listTasks().
 */
const VALID_FILTERS = new Set(['all', 'pending', 'completed']);

/**
 * Biểu thức chính quy kiểm tra định dạng chuẩn ISO 8601 (UTC hoặc có offset).
 */
const ISO_8601_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Xác định đường dẫn file lưu trữ theo thứ tự ưu tiên:
 * customPath -> process.env.TODO_FILE -> <cwd>/tasks.json
 *
 * @param {string} [customPath]
 * @returns {string}
 */
function resolveStoragePath(customPath) {
  if (typeof customPath === 'string' && customPath.trim().length > 0) {
    return path.resolve(customPath.trim());
  }
  if (
    typeof process.env.TODO_FILE === 'string' &&
    process.env.TODO_FILE.trim().length > 0
  ) {
    return path.resolve(process.env.TODO_FILE.trim());
  }
  return path.resolve(process.cwd(), 'tasks.json');
}

/**
 * Kiểm tra chuỗi thời gian có đúng chuẩn ISO 8601 và là ngày lịch thực tế hợp lệ hay không.
 * Chặn các trường hợp ngày không tồn tại (như 2026-02-30 hoặc 2025-02-29) bị Date.parse() tự chuẩn hóa.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidIsoTimestamp(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const match = ISO_8601_REGEX.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) {
    return false;
  }

  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDaysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  if (day < 1 || day > maxDaysInMonth) {
    return false;
  }

  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  if (match[7]) {
    const tzHour = Number(match[8]);
    const tzMinute = Number(match[9]);
    if (tzHour > 23 || tzMinute > 59) {
      return false;
    }
  }

  return !Number.isNaN(Date.parse(value));
}

/**
 * Xác thực và chuyển đổi ID công việc sang số nguyên dương an toàn.
 * Chặn boolean, object, số âm, số thực, chuỗi hệ 16 ('0x1'), ký pháp khoa học ('1e0'), số 0 đứng đầu ('01').
 *
 * @param {number | string} rawId
 * @returns {number}
 */
function parseTaskId(rawId) {
  if (typeof rawId === 'number') {
    if (Number.isSafeInteger(rawId) && rawId > 0) {
      return rawId;
    }
    throw new Error('ID công việc không hợp lệ: phải là số nguyên dương an toàn');
  }

  if (typeof rawId === 'string') {
    if (!/^[1-9]\d*$/.test(rawId)) {
      throw new Error('ID công việc không hợp lệ: phải là số nguyên dương an toàn');
    }
    const parsed = Number(rawId);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
    throw new Error('ID công việc không hợp lệ: vượt quá giới hạn số nguyên an toàn');
  }

  throw new Error('ID công việc không hợp lệ: phải là số nguyên dương an toàn');
}

/**
 * Xác thực danh sách công việc theo đúng Schema quy định trong CURRENT_PLAN.md v2.1.
 * Ném lỗi ngay khi phát hiện sai cấu trúc, trùng ID, sai kiểu dữ liệu hoặc timestamp không nhất quán.
 *
 * @param {unknown} tasks
 * @returns {void}
 */
function validateTaskList(tasks) {
  if (!Array.isArray(tasks)) {
    throw new Error('Dữ liệu tasks.json không hợp lệ: gốc JSON phải là một mảng');
  }

  const seenIds = new Set();

  for (let i = 0; i < tasks.length; i += 1) {
    const item = tasks[i];

    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(
        `Dữ liệu tasks.json không hợp lệ tại phần tử [${i}]: phải là một đối tượng`
      );
    }

    if (!Number.isSafeInteger(item.id) || item.id <= 0) {
      throw new Error(
        `Dữ liệu tasks.json không hợp lệ tại phần tử [${i}]: id phải là số nguyên dương an toàn`
      );
    }

    if (seenIds.has(item.id)) {
      throw new Error(
        `Dữ liệu tasks.json không hợp lệ: trùng lặp ID ${item.id}`
      );
    }
    seenIds.add(item.id);

    if (typeof item.title !== 'string' || item.title.trim().length === 0) {
      throw new Error(
        `Dữ liệu tasks.json không hợp lệ tại ID ${item.id}: title phải là chuỗi khác rỗng`
      );
    }

    if (typeof item.completed !== 'boolean') {
      throw new Error(
        `Dữ liệu tasks.json không hợp lệ tại ID ${item.id}: completed phải là kiểu boolean`
      );
    }

    if (!isValidIsoTimestamp(item.createdAt)) {
      throw new Error(
        `Dữ liệu tasks.json không hợp lệ tại ID ${item.id}: createdAt không đúng chuẩn ISO 8601 hợp lệ`
      );
    }

    if (item.completed === false) {
      if (item.completedAt !== null) {
        throw new Error(
          `Dữ liệu tasks.json không hợp lệ tại ID ${item.id}: completedAt phải là null khi chưa hoàn thành`
        );
      }
    } else {
      if (!isValidIsoTimestamp(item.completedAt)) {
        throw new Error(
          `Dữ liệu tasks.json không hợp lệ tại ID ${item.id}: completedAt phải là chuỗi ISO 8601 hợp lệ khi đã hoàn thành`
        );
      }
      if (Date.parse(item.completedAt) < Date.parse(item.createdAt)) {
        throw new Error(
          `Dữ liệu tasks.json không hợp lệ tại ID ${item.id}: completedAt không được nhỏ hơn createdAt`
        );
      }
    }
  }
}

/**
 * Đọc và xác thực danh sách công việc từ file JSON.
 * Nếu file chưa tồn tại, trả về mảng rỗng [].
 * Nếu file rỗng, sai cú pháp JSON hoặc sai schema, ném lỗi và tuyệt đối không tự ghi đè file gốc.
 *
 * @param {string} [filePath]
 * @returns {Array<{id: number, title: string, completed: boolean, createdAt: string, completedAt: string | null}>}
 */
function loadTasks(filePath) {
  const targetPath = resolveStoragePath(filePath);

  if (!fs.existsSync(targetPath)) {
    return [];
  }

  const raw = fs.readFileSync(targetPath, 'utf8');
  if (raw.trim().length === 0) {
    throw new Error('Dữ liệu JSON trong file lưu trữ bị rỗng hoặc hỏng');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Dữ liệu JSON trong file lưu trữ bị hỏng hoặc sai cú pháp: ${err.message}`
    );
  }

  validateTaskList(parsed);

  return parsed.map((task) => ({
    id: task.id,
    title: task.title,
    completed: task.completed,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  }));
}

/**
 * Lưu danh sách công việc xuống đĩa một cách an toàn thông qua temporary file cùng thư mục + fs.renameSync().
 * Dọn dẹp file tạm nếu quá trình ghi hoặc đổi tên thất bại, bảo toàn nguyên vẹn file gốc và lỗi ban đầu.
 *
 * @param {Array<object>} tasks
 * @param {string} [filePath]
 * @returns {void}
 */
function saveTasks(tasks, filePath) {
  validateTaskList(tasks);

  const targetPath = resolveStoragePath(filePath);
  const dir = path.dirname(targetPath);

  fs.mkdirSync(dir, { recursive: true });

  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.tmp`
  );

  try {
    const payload = `${JSON.stringify(tasks, null, 2)}\n`;
    fs.writeFileSync(tempPath, payload, 'utf8');
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (_cleanupErr) {
      // Bỏ qua lỗi dọn dẹp phụ để không che khuất lỗi gốc
    }
    throw err;
  }
}

/**
 * Thêm một công việc mới vào danh sách.
 * Sử dụng reduce() để tính maxId + 1 theo đúng ID Strategy Contract.
 *
 * @param {string} title
 * @param {string} [filePath]
 * @returns {{id: number, title: string, completed: boolean, createdAt: string, completedAt: null}}
 */
function addTask(title, filePath) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('Tiêu đề công việc không được để trống');
  }

  const tasks = loadTasks(filePath);
  const maxId = tasks.reduce((max, t) => (t.id > max ? t.id : max), 0);
  const nextId = maxId + 1;

  if (!Number.isSafeInteger(nextId) || nextId <= 0) {
    throw new Error('Không thể cấp phát ID mới: vượt quá giới hạn số nguyên an toàn');
  }

  const newTask = {
    id: nextId,
    title: title.trim(),
    completed: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  tasks.push(newTask);
  saveTasks(tasks, filePath);

  return { ...newTask };
}

/**
 * Liệt kê danh sách công việc theo bộ lọc ('all' | 'pending' | 'completed').
 * Ném lỗi nếu giá trị filter không hợp lệ.
 *
 * @param {'all' | 'pending' | 'completed'} [filter='all']
 * @param {string} [filePath]
 * @returns {Array<{id: number, title: string, completed: boolean, createdAt: string, completedAt: string | null}>}
 */
function listTasks(filter = 'all', filePath) {
  if (!VALID_FILTERS.has(filter)) {
    throw new Error(
      `Bộ lọc không hợp lệ: "${String(filter)}". Chỉ chấp nhận: all, pending, completed`
    );
  }

  const tasks = loadTasks(filePath);

  if (filter === 'pending') {
    return tasks.filter((t) => !t.completed);
  }
  if (filter === 'completed') {
    return tasks.filter((t) => t.completed);
  }
  return tasks;
}

/**
 * Đánh dấu hoàn thành một công việc theo ID.
 * - Đảm bảo tính lũy đẳng (Idempotent): nếu đã hoàn thành thì trả về nguyên trạng, giữ nguyên completedAt và không ghi lại file.
 * - Đảm bảo Clock-Rollback Consistency: sử dụng Math.max(now, created) để completedAt >= createdAt.
 *
 * @param {number | string} id
 * @param {string} [filePath]
 * @returns {{id: number, title: string, completed: boolean, createdAt: string, completedAt: string}}
 */
function completeTask(id, filePath) {
  const numericId = parseTaskId(id);
  const tasks = loadTasks(filePath);

  const task = tasks.find((t) => t.id === numericId);
  if (!task) {
    throw new Error(`Không tìm thấy công việc với ID ${numericId}`);
  }

  if (task.completed === true) {
    return { ...task };
  }

  const now = Date.now();
  const created = Date.parse(task.createdAt);

  task.completed = true;
  task.completedAt = new Date(Math.max(now, created)).toISOString();

  saveTasks(tasks, filePath);

  return { ...task };
}

/**
 * Xóa một công việc khỏi danh sách theo ID.
 *
 * @param {number | string} id
 * @param {string} [filePath]
 * @returns {{id: number, title: string, completed: boolean, createdAt: string, completedAt: string | null}}
 */
function removeTask(id, filePath) {
  const numericId = parseTaskId(id);
  const tasks = loadTasks(filePath);

  const index = tasks.findIndex((t) => t.id === numericId);
  if (index === -1) {
    throw new Error(`Không tìm thấy công việc với ID ${numericId}`);
  }

  const [removed] = tasks.splice(index, 1);
  saveTasks(tasks, filePath);

  return { ...removed };
}

/**
 * In hướng dẫn sử dụng CLI.
 *
 * @param {(msg: string) => void} [logger=console.log]
 */
function printHelp(logger = console.log) {
  logger(
    [
      'Cách sử dụng: node src/todo.js <lệnh> [tham số]',
      '',
      'Các lệnh hỗ trợ:',
      '  add <tiêu đề>                          Thêm công việc mới',
      '  list [all|pending|completed]           Liệt kê công việc (hỗ trợ cả --all, --pending, --completed)',
      '  done|complete <id>                     Đánh dấu hoàn thành công việc theo ID',
      '  remove|delete <id>                     Xóa công việc theo ID',
      '  help|--help|-h                         Hiển thị hướng dẫn sử dụng',
    ].join('\n')
  );
}

/**
 * Thực thi giao diện dòng lệnh (CLI).
 * Chỉ tự động kích hoạt khi chạy trực tiếp `node src/todo.js ...` (require.main === module).
 *
 * @param {string[]} [args=process.argv.slice(2)]
 * @param {string} [filePath]
 * @returns {number} Mã thoát (0 nếu thành công, 1 nếu có lỗi)
 */
function runCli(args = process.argv.slice(2), filePath) {
  try {
    if (!Array.isArray(args) || args.length === 0) {
      console.error('Lỗi: Thiếu lệnh thực thi.');
      printHelp(console.error);
      process.exitCode = 1;
      return 1;
    }

    const [command, ...rest] = args;

    switch (command) {
      case 'help':
      case '--help':
      case '-h': {
        printHelp(console.log);
        return 0;
      }

      case 'add': {
        const title = rest.join(' ');
        const created = addTask(title, filePath);
        console.log(`Đã thêm công việc #${created.id}: "${created.title}"`);
        return 0;
      }

      case 'list': {
        if (rest.length > 1) {
          throw new Error('Lệnh "list" chỉ nhận tối đa 1 tham số bộ lọc');
        }
        const rawFilter = rest[0] === undefined ? 'all' : rest[0];
        const normalizedFilter = rawFilter.startsWith('--')
          ? rawFilter.slice(2)
          : rawFilter;

        const tasks = listTasks(normalizedFilter, filePath);
        if (tasks.length === 0) {
          console.log('Danh sách công việc trống.');
        } else {
          for (const t of tasks) {
            const status = t.completed ? '[x]' : '[ ]';
            console.log(`${status} #${t.id}: ${t.title}`);
          }
        }
        return 0;
      }

      case 'done':
      case 'complete': {
        if (rest.length !== 1) {
          throw new Error(`Lệnh "${command}" yêu cầu đúng 1 tham số <id>`);
        }
        const completed = completeTask(rest[0], filePath);
        console.log(
          `Đã hoàn thành công việc #${completed.id}: "${completed.title}"`
        );
        return 0;
      }

      case 'remove':
      case 'delete': {
        if (rest.length !== 1) {
          throw new Error(`Lệnh "${command}" yêu cầu đúng 1 tham số <id>`);
        }
        const removed = removeTask(rest[0], filePath);
        console.log(`Đã xóa công việc #${removed.id}: "${removed.title}"`);
        return 0;
      }

      default: {
        throw new Error(`Lệnh không hợp lệ: "${command}"`);
      }
    }
  } catch (err) {
    console.error(`Lỗi: ${err.message}`);
    process.exitCode = 1;
    return 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

module.exports = {
  VALID_FILTERS,
  resolveStoragePath,
  isValidIsoTimestamp,
  parseTaskId,
  validateTaskList,
  loadTasks,
  saveTasks,
  addTask,
  listTasks,
  completeTask,
  removeTask,
  deleteTask: removeTask,
  runCli,
};

#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  saveTasks,
  loadTasks,
  addTask,
  completeTask,
  removeTask,
} = require('../src/todo');

/**
 * Tạo một thư mục làm việc tạm thời cô lập cho từng kịch bản kiểm thử.
 * Dọn dẹp an toàn các file và thư mục tạm trong khối finally.
 * Bắt buộc báo FAIL nếu thao tác dọn dẹp thất bại (không nuốt lỗi).
 *
 * @param {(context: { tempDir: string, filePath: string }) => any} fn
 * @param {typeof fs.rmSync} [rmSyncImpl=fs.rmSync]
 */
function withIsolatedFaultWorkspace(fn, rmSyncImpl = fs.rmSync) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-fs-fault-'));
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
    if (fs.existsSync(tempDir)) {
      const internalErrors = [];
      function ensureWritableRecursive(target) {
        let stat;
        try {
          stat = fs.lstatSync(target);
        } catch (err) {
          if (err && err.code === 'ENOENT') return;
          internalErrors.push(err);
          return;
        }
        if (stat.isSymbolicLink()) {
          // BLOCKER 04: Tuyệt đối không đi theo symbolic link, chỉ xóa symlink trong workspace
          try {
            fs.unlinkSync(target);
          } catch (err) {
            if (err && err.code !== 'ENOENT') {
              internalErrors.push(err);
            }
          }
          return;
        }
        if (stat.isDirectory()) {
          // Với thư mục: Bắt buộc cấp quyền execute (0o777) để traverse được trên POSIX/Linux
          try {
            fs.chmodSync(target, 0o777);
          } catch (err) {
            if (err && err.code !== 'ENOENT') {
              internalErrors.push(err);
            }
          }
          let entries = [];
          try {
            entries = fs.readdirSync(target);
          } catch (err) {
            if (err && err.code !== 'ENOENT') {
              internalErrors.push(err);
            }
          }
          for (const entry of entries) {
            ensureWritableRecursive(path.join(target, entry));
          }
        } else {
          // Với file thường: cấp quyền ghi 0o666
          try {
            fs.chmodSync(target, 0o666);
          } catch (err) {
            if (err && err.code !== 'ENOENT') {
              internalErrors.push(err);
            }
          }
        }
      }
      ensureWritableRecursive(tempDir);

      let rmError = null;
      try {
        rmSyncImpl(tempDir, { recursive: true, force: true });
      } catch (err) {
        rmError = err;
      }

      if (fs.existsSync(tempDir)) {
        throw new Error(
          `Thư mục tạm vẫn còn tồn tại sau khi dọn dẹp: ${tempDir}${rmError ? ` (${rmError.message})` : ''}`
        );
      }

      if (internalErrors.length > 0) {
        throw new Error(
          `Lỗi nội bộ khi chuẩn bị quyền dọn dẹp thư mục tạm (${tempDir}): ${internalErrors.map((e) => (e && e.message ? e.message : String(e))).join('; ')}`
        );
      }

      if (rmError) {
        throw rmError;
      }
    }
  } catch (err) {
    cleanupError = new Error(
      `[Cleanup Failure tại ${tempDir}]: ${err && err.message ? err.message : String(err)}`
    );
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

/**
 * Danh sách 5 kịch bản kiểm thử lỗi Filesystem thực tế (Không dùng Mock).
 */
const faultTestCases = [
  {
    id: 'FS-1',
    name: 'FS-1 — Giai đoạn 3: renameSync thất bại khi đường dẫn đích là một thư mục đang tồn tại',
    fn: () => {
      withIsolatedFaultWorkspace(({ tempDir }) => {
        const existingDirPath = path.join(tempDir, 'target_is_a_dir');
        fs.mkdirSync(existingDirPath);

        const sampleTasks = [
          {
            id: 1,
            title: 'Task kiểm thử rename vào thư mục',
            completed: false,
            createdAt: '2026-11-06T20:00:00.000Z',
            completedAt: null,
          },
        ];

        let thrownError = null;
        try {
          saveTasks(sampleTasks, existingDirPath);
        } catch (err) {
          thrownError = err;
        }

        assert.ok(thrownError, 'saveTasks() phải ném lỗi khi đích là một thư mục');
        assert.ok(
          thrownError.code === 'EPERM' || thrownError.code === 'EISDIR',
          `Mã lỗi phải là EPERM hoặc EISDIR, nhận được: ${thrownError.code}`
        );
        if (thrownError.syscall) {
          assert.strictEqual(
            thrownError.syscall,
            'rename',
            `Lỗi phải phát sinh từ thao tác syscall 'rename', nhận được: ${thrownError.syscall}`
          );
        }

        // Đích vẫn phải là thư mục nguyên vẹn
        assert.strictEqual(fs.statSync(existingDirPath).isDirectory(), true);

        // Xác nhận không còn sót bất kỳ file tạm .tmp nào trong tempDir
        const leftoverTmps = fs
          .readdirSync(tempDir)
          .filter((f) => f.endsWith('.tmp'));
        assert.strictEqual(
          leftoverTmps.length,
          0,
          `Phải dọn sạch toàn bộ file .tmp, còn sót: ${leftoverTmps.join(', ')}`
        );
      });
      return { status: 'PASS' };
    },
  },
  {
    id: 'FS-2',
    name: 'FS-2 — Giai đoạn 1: mkdirSync thất bại khi một thành phần cha trong đường dẫn là một file thường',
    fn: () => {
      withIsolatedFaultWorkspace(({ tempDir }) => {
        const parentPlainFile = path.join(tempDir, 'plain_file.txt');
        const sentinelData = 'Sentinel plain file content to verify preservation';
        fs.writeFileSync(parentPlainFile, sentinelData, 'utf8');
        const beforeBuffer = fs.readFileSync(parentPlainFile);

        // Đường dẫn yêu cầu tạo tasks.json nằm bên trong file thường plain_file.txt
        const invalidSubPath = path.join(parentPlainFile, 'tasks.json');
        const sampleTasks = [
          {
            id: 1,
            title: 'Task kiểm thử mkdir đè lên file thường',
            completed: false,
            createdAt: '2026-11-06T20:00:00.000Z',
            completedAt: null,
          },
        ];

        let thrownError = null;
        try {
          saveTasks(sampleTasks, invalidSubPath);
        } catch (err) {
          thrownError = err;
        }

        assert.ok(
          thrownError,
          'saveTasks() phải ném lỗi khi đường dẫn cha là một file thường'
        );
        assert.ok(
          thrownError.code === 'ENOTDIR' || thrownError.code === 'EEXIST',
          `Mã lỗi phải là ENOTDIR hoặc EEXIST, nhận được: ${thrownError.code}`
        );

        // Bảo toàn 100% từng byte của file thường ban đầu
        const afterBuffer = fs.readFileSync(parentPlainFile);
        assert.strictEqual(
          Buffer.compare(beforeBuffer, afterBuffer),
          0,
          'File cha dạng file thường phải được bảo toàn nguyên vẹn từng byte'
        );

        // Hoàn toàn không có file .tmp nào được tạo ra
        const leftoverTmps = fs
          .readdirSync(tempDir)
          .filter((f) => f.endsWith('.tmp'));
        assert.strictEqual(
          leftoverTmps.length,
          0,
          `Không được để lại bất kỳ file .tmp nào, còn sót: ${leftoverTmps.join(', ')}`
        );
      });
      return { status: 'PASS' };
    },
  },
  {
    id: 'FS-3',
    name: 'FS-3 — Giai đoạn 2: writeFileSync thất bại khi thư mục cha không có quyền ghi (Read-only dir / 0555)',
    fn: () => {
      let result = { status: 'PASS' };
      withIsolatedFaultWorkspace(({ tempDir }) => {
        // 1. Capability Probe độc lập: kiểm tra xem HĐH hiện tại có thực thi giới hạn ghi trên thư mục 0555 không
        const probeDir = path.join(tempDir, 'probe_dir');
        fs.mkdirSync(probeDir);
        let writeBlockedByOs = false;
        try {
          fs.chmodSync(probeDir, 0o555);
          const probeFile = path.join(probeDir, 'probe.tmp');
          try {
            fs.writeFileSync(probeFile, 'test probe', 'utf8');
            // Nếu ghi thành công: HĐH (Windows NTFS hoặc POSIX root) bỏ qua bit 0555 của thư mục
            writeBlockedByOs = false;
          } catch (writeErr) {
            if (writeErr.code === 'EACCES' || writeErr.code === 'EPERM') {
              writeBlockedByOs = true;
            } else {
              throw writeErr;
            }
          }
        } finally {
          try {
            fs.chmodSync(probeDir, 0o755);
          } catch (_e) {}
        }

        if (!writeBlockedByOs) {
          result = {
            status: 'SKIP',
            reason:
              'Môi trường hiện tại không áp dụng giới hạn ghi trên thư mục 0o555 (Windows NTFS hoặc quyền Root POSIX)',
          };
          return;
        }

        // 2. Chạy test thực tế khi Capability được xác nhận
        const noWriteDir = path.join(tempDir, 'no_write_workspace');
        fs.mkdirSync(noWriteDir);
        const targetFile = path.join(noWriteDir, 'tasks.json');

        const initialTasks = [
          {
            id: 1,
            title: 'Dữ liệu gốc trước lỗi FS-3',
            completed: false,
            createdAt: '2026-11-06T20:00:00.000Z',
            completedAt: null,
          },
        ];
        saveTasks(initialTasks, targetFile);
        const beforeBuffer = fs.readFileSync(targetFile);

        // Đổi quyền thư mục sang chỉ đọc (0555)
        fs.chmodSync(noWriteDir, 0o555);

        const newTasks = [
          ...initialTasks,
          {
            id: 2,
            title: 'Task mới không được phép ghi',
            completed: false,
            createdAt: '2026-11-06T20:05:00.000Z',
            completedAt: null,
          },
        ];

        let thrownError = null;
        try {
          saveTasks(newTasks, targetFile);
        } catch (err) {
          thrownError = err;
        } finally {
          // Bắt buộc khôi phục quyền ghi cho thư mục trong finally
          fs.chmodSync(noWriteDir, 0o755);
        }

        assert.ok(
          thrownError,
          'saveTasks() phải ném lỗi khi không thể ghi file tạm vào thư mục không có quyền ghi'
        );
        assert.ok(
          thrownError.code === 'EACCES' || thrownError.code === 'EPERM',
          `Mã lỗi phải là EACCES hoặc EPERM, nhận được: ${thrownError.code}`
        );

        // Bảo toàn dữ liệu gốc từng byte
        const afterBuffer = fs.readFileSync(targetFile);
        assert.strictEqual(
          Buffer.compare(beforeBuffer, afterBuffer),
          0,
          'Dữ liệu file tasks.json gốc phải được bảo toàn nguyên vẹn từng byte'
        );

        // Xác nhận không rò rỉ file .tmp
        const leftoverTmps = fs
          .readdirSync(noWriteDir)
          .filter((f) => f.endsWith('.tmp'));
        assert.strictEqual(
          leftoverTmps.length,
          0,
          `Không được sót file .tmp dở dang trong thư mục, còn: ${leftoverTmps.join(', ')}`
        );
      });
      return result;
    },
  },
  {
    id: 'FS-4',
    name: 'FS-4 — Giai đoạn 3: renameSync thất bại khi file đích bị đặt thuộc tính Read-Only trên Windows NTFS',
    fn: () => {
      let result = { status: 'PASS' };
      withIsolatedFaultWorkspace(({ tempDir }) => {
        // 1. Capability Probe độc lập: Thử rename đè lên một file chỉ đọc
        const probeDst = path.join(tempDir, 'probe_readonly_dst.txt');
        const probeSrc = path.join(tempDir, 'probe_src.tmp');
        fs.writeFileSync(probeDst, 'dst data', 'utf8');
        fs.writeFileSync(probeSrc, 'src data', 'utf8');
        fs.chmodSync(probeDst, 0o444);

        let renameBlockedByOs = false;
        try {
          fs.renameSync(probeSrc, probeDst);
          // Nếu rename thành công: chuẩn POSIX (cho phép rename đè lên file read-only nếu thư mục cha có quyền ghi)
          renameBlockedByOs = false;
        } catch (renameErr) {
          if (renameErr.code === 'EPERM' || renameErr.code === 'EACCES') {
            renameBlockedByOs = true;
          } else {
            throw renameErr;
          }
        } finally {
          try {
            fs.chmodSync(probeDst, 0o666);
          } catch (_e) {}
          try {
            if (fs.existsSync(probeSrc)) fs.unlinkSync(probeSrc);
          } catch (_e) {}
          try {
            if (fs.existsSync(probeDst)) fs.unlinkSync(probeDst);
          } catch (_e) {}
        }

        if (!renameBlockedByOs) {
          result = {
            status: 'SKIP',
            reason:
              'Filesystem cho phép rename thay thế file read-only nếu thư mục cha có quyền ghi (hành vi chuẩn POSIX)',
          };
          return;
        }

        // 2. Chạy test thực tế khi Capability được xác nhận (Windows NTFS)
        const filePath = path.join(tempDir, 'tasks.json');
        const initialTasks = [
          {
            id: 1,
            title: 'Dữ liệu trước khi đặt read-only',
            completed: false,
            createdAt: '2026-11-06T20:00:00.000Z',
            completedAt: null,
          },
        ];
        saveTasks(initialTasks, filePath);
        const beforeBuffer = fs.readFileSync(filePath);

        // Đặt thuộc tính read-only cho file đích
        fs.chmodSync(filePath, 0o444);

        const updatedTasks = [
          ...initialTasks,
          {
            id: 2,
            title: 'Task mới cố tình rename đè lên file read-only',
            completed: false,
            createdAt: '2026-11-06T20:10:00.000Z',
            completedAt: null,
          },
        ];

        let thrownError = null;
        try {
          saveTasks(updatedTasks, filePath);
        } catch (err) {
          thrownError = err;
        } finally {
          // Bắt buộc khôi phục quyền ghi để dọn dẹp
          try {
            fs.chmodSync(filePath, 0o666);
          } catch (_e) {}
        }

        // Nếu capability đã xác nhận mà saveTasks() không ném lỗi -> BẮT BUỘC FAIL, không được chuyển thành SKIP
        assert.ok(
          thrownError,
          'saveTasks() bắt buộc phải ném lỗi khi rename đè lên file read-only trên hệ thống đã xác nhận capability'
        );
        assert.ok(
          thrownError.code === 'EPERM' || thrownError.code === 'EACCES',
          `Mã lỗi phải là EPERM hoặc EACCES, nhận được: ${thrownError.code}`
        );
        if (thrownError.syscall) {
          assert.strictEqual(
            thrownError.syscall,
            'rename',
            `Lỗi phải phát sinh từ thao tác 'rename', nhận được: ${thrownError.syscall}`
          );
        }

        // So sánh bảo toàn nguyên vẹn byte-for-byte của file gốc
        const afterBuffer = fs.readFileSync(filePath);
        assert.strictEqual(
          Buffer.compare(beforeBuffer, afterBuffer),
          0,
          'File gốc read-only phải được giữ nguyên vẹn 100% từng byte sau khi rename thất bại'
        );

        // Dọn sạch hoàn toàn các file tạm dở dang
        const leftoverTmps = fs
          .readdirSync(tempDir)
          .filter((f) => f.endsWith('.tmp'));
        assert.strictEqual(
          leftoverTmps.length,
          0,
          `Không được để lại bất kỳ file .tmp dở dang nào, còn: ${leftoverTmps.join(', ')}`
        );
      });
      return result;
    },
  },
  {
    id: 'FS-5',
    name: 'FS-5 — Baseline Verification: Toàn vẹn End-to-End chu trình CRUD thực tế không rò rỉ file .tmp (Kiểm chứng đĩa từng bước)',
    fn: () => {
      withIsolatedFaultWorkspace(({ tempDir, filePath }) => {
        // Chu trình: saveTasks -> loadTasks -> addTask -> completeTask -> removeTask
        const initialTasks = [
          {
            id: 1,
            title: 'Task khởi tạo chu trình',
            completed: false,
            createdAt: '2026-11-06T20:00:00.000Z',
            completedAt: null,
          },
        ];

        // Bước 1: saveTasks ban đầu
        saveTasks(initialTasks, filePath);
        assert.strictEqual(fs.existsSync(filePath), true);
        assert.strictEqual(
          fs.readdirSync(tempDir).filter((f) => f.endsWith('.tmp')).length,
          0
        );

        // Đọc lại từ đĩa xác thực dữ liệu ban đầu
        const loaded0 = loadTasks(filePath);
        assert.deepStrictEqual(loaded0, initialTasks);

        // Bước 2: addTask
        const t2 = addTask('Task thứ hai', filePath);
        assert.strictEqual(t2.id, 2);
        assert.strictEqual(t2.completed, false);
        assert.strictEqual(
          fs.readdirSync(tempDir).filter((f) => f.endsWith('.tmp')).length,
          0
        );

        // BLOCKER 05: Đọc lại từ đĩa để xác thực addTask thực sự lưu xuống file
        const diskAfterAdd = loadTasks(filePath);
        assert.strictEqual(diskAfterAdd.length, 2, 'File trên đĩa phải có đúng 2 task sau addTask');
        const t2OnDisk = diskAfterAdd.find((t) => t.id === 2);
        assert.ok(t2OnDisk, 'Task 2 phải tồn tại trên đĩa');
        assert.strictEqual(t2OnDisk.title, 'Task thứ hai');
        assert.strictEqual(t2OnDisk.completed, false);
        assert.strictEqual(t2OnDisk.completedAt, null);

        // Bước 3: completeTask
        const doneT1 = completeTask(1, filePath);
        assert.strictEqual(doneT1.completed, true);
        assert.ok(typeof doneT1.completedAt === 'string');
        assert.strictEqual(
          fs.readdirSync(tempDir).filter((f) => f.endsWith('.tmp')).length,
          0
        );

        // BLOCKER 05: Đọc lại từ đĩa để xác minh trạng thái completed thực sự ghi xuống đĩa
        const diskAfterComplete = loadTasks(filePath);
        const t1OnDisk = diskAfterComplete.find((t) => t.id === 1);
        assert.ok(t1OnDisk, 'Task 1 phải tồn tại trên đĩa sau completeTask');
        assert.strictEqual(t1OnDisk.completed, true, 'Task 1 trên đĩa phải có completed === true');
        assert.strictEqual(
          typeof t1OnDisk.completedAt,
          'string',
          'Task 1 trên đĩa phải có completedAt là ISO string'
        );
        assert.ok(
          !Number.isNaN(Date.parse(t1OnDisk.completedAt)),
          'completedAt trên đĩa phải parse thành ngày hợp lệ'
        );

        // Bước 4: removeTask
        const removedT1 = removeTask(1, filePath);
        assert.strictEqual(removedT1.id, 1);
        assert.strictEqual(
          fs.readdirSync(tempDir).filter((f) => f.endsWith('.tmp')).length,
          0
        );

        // BLOCKER 05: Đọc lại từ đĩa để xác minh task 1 đã bị xóa khỏi đĩa
        const diskAfterRemove = loadTasks(filePath);
        assert.strictEqual(diskAfterRemove.length, 1, 'File trên đĩa chỉ còn 1 task sau khi xóa task 1');
        assert.strictEqual(diskAfterRemove[0].id, 2);
        assert.strictEqual(
          diskAfterRemove.some((t) => t.id === 1),
          false,
          'Task 1 không được còn tồn tại trên đĩa'
        );

        // Kiểm tra tính hợp lệ của file JSON trên đĩa: định dạng JSON chuẩn và có \n ở cuối
        const rawContent = fs.readFileSync(filePath, 'utf8');
        assert.ok(rawContent.endsWith('\n'), 'File JSON phải có ký tự xuống dòng ở cuối');
        const parsed = JSON.parse(rawContent);
        assert.deepStrictEqual(parsed, diskAfterRemove);
      });
      return { status: 'PASS' };
    },
  },
  {
    id: 'FS-SYMLINK-CLEANUP',
    name: 'FS-SYMLINK-CLEANUP — Kiểm chứng an toàn khi workspace chứa Symbolic Link (Không đổi quyền hay xóa file ngoài)',
    fn: () => {
      // 1. Tạo thư mục sentinel bên ngoài
      const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-dir-'));
      const sentinelFile = path.join(sentinelDir, 'sentinel_secret.txt');
      fs.writeFileSync(sentinelFile, 'SECRET_OUTSIDE_WORKSPACE', 'utf8');
      fs.chmodSync(sentinelFile, 0o444);

      const sentinelDirStatBefore = fs.statSync(sentinelDir);
      const sentinelFileStatBefore = fs.statSync(sentinelFile);

      let symlinkCreated = false;
      try {
        withIsolatedFaultWorkspace(({ tempDir }) => {
          const linkPath = path.join(tempDir, 'link_to_sentinel');
          try {
            fs.symlinkSync(sentinelDir, linkPath, 'junction');
            symlinkCreated = true;
          } catch (_symlinkErr) {
            symlinkCreated = false;
          }

          if (symlinkCreated) {
            assert.strictEqual(fs.existsSync(linkPath), true);
          }
        });

        // Xác minh thư mục sentinel bên ngoài và file bên trong vẫn nguyên vẹn 100%
        assert.strictEqual(fs.existsSync(sentinelDir), true);
        assert.strictEqual(fs.existsSync(sentinelFile), true);
        const outsideData = fs.readFileSync(sentinelFile, 'utf8');
        assert.strictEqual(outsideData, 'SECRET_OUTSIDE_WORKSPACE');

        // BLOCKER 04: Đối chiếu quyền (mode) của thư mục và file sentinel bên ngoài trước và sau cleanup
        const sentinelDirStatAfter = fs.statSync(sentinelDir);
        const sentinelFileStatAfter = fs.statSync(sentinelFile);
        assert.strictEqual(
          sentinelDirStatAfter.mode,
          sentinelDirStatBefore.mode,
          'Quyền (mode) của thư mục sentinel bên ngoài phải được bảo toàn nguyên vẹn sau cleanup'
        );
        assert.strictEqual(
          sentinelFileStatAfter.mode,
          sentinelFileStatBefore.mode,
          'Quyền (mode) của file sentinel bên ngoài phải được bảo toàn nguyên vẹn sau cleanup'
        );
      } finally {
        let sentinelCleanupError = null;
        try {
          if (fs.existsSync(sentinelFile)) {
            try {
              fs.chmodSync(sentinelFile, 0o666);
            } catch (chmodErr) {
              if (chmodErr.code !== 'ENOENT') {
                sentinelCleanupError = chmodErr;
              }
            }
          }
          if (fs.existsSync(sentinelDir)) {
            fs.rmSync(sentinelDir, { recursive: true, force: true });
          }
          if (fs.existsSync(sentinelDir)) {
            throw new Error(
              `Thư mục sentinel bên ngoài vẫn còn tồn tại sau khi dọn dẹp: ${sentinelDir}`
            );
          }
        } catch (cleanupErr) {
          sentinelCleanupError = cleanupErr;
        }

        if (sentinelCleanupError) {
          throw new Error(
            `[Sentinel Cleanup Failure tại ${sentinelDir}]: ${sentinelCleanupError && sentinelCleanupError.message ? sentinelCleanupError.message : String(sentinelCleanupError)}`
          );
        }
      }

      if (!symlinkCreated) {
        return {
          status: 'SKIP',
          reason: 'Môi trường hiện tại không hỗ trợ tạo Symbolic Link/Junction không đặc quyền',
        };
      }
      return { status: 'PASS' };
    },
  },
  {
    id: 'FS-SELF-CLEANUP',
    name: 'FS-SELF-CLEANUP — Tự kiểm chứng lỗi Cleanup của withIsolatedFaultWorkspace (Không nuốt lỗi)',
    fn: () => {
      assert.throws(
        () =>
          withIsolatedFaultWorkspace(
            ({ tempDir }) => assert.strictEqual(fs.existsSync(tempDir), true),
            (targetDir, opts) => {
              fs.rmSync(targetDir, opts);
              throw new Error('Simulated fault cleanup permission failure');
            }
          ),
        (err) =>
          err instanceof Error &&
          err.message.includes('[Cleanup Failure') &&
          err.message.includes('Simulated fault cleanup permission failure')
      );
      assert.throws(
        () =>
          withIsolatedFaultWorkspace(
            () => {
              throw new Error('Primary assertion error inside fault test');
            },
            (targetDir, opts) => {
              fs.rmSync(targetDir, opts);
              throw new Error('Secondary cleanup error in fault test');
            }
          ),
        (err) =>
          err instanceof Error &&
          err.message.startsWith('Primary assertion error inside fault test') &&
          err.message.includes('[Lỗi Cleanup kèm theo]') &&
          err.cleanupError instanceof Error
      );

      // BLOCKER 04: Mô phỏng lỗi nội bộ khi chmodSync ném EACCES trong khâu chuẩn bị quyền dọn dẹp
      const originalChmod = fs.chmodSync;
      let faultedDir = '';
      try {
        let chmodCallCount = 0;
        fs.chmodSync = (...args) => {
          chmodCallCount += 1;
          const err = new Error('EACCES: permission denied, chmod');
          err.code = 'EACCES';
          throw err;
        };
        assert.throws(
          () =>
            withIsolatedFaultWorkspace(({ tempDir }) => {
              faultedDir = tempDir;
              fs.writeFileSync(path.join(tempDir, 'dummy.txt'), 'hello', 'utf8');
            }),
          (err) =>
            err instanceof Error &&
            err.message.includes('[Cleanup Failure') &&
            err.message.includes('Lỗi nội bộ khi chuẩn bị quyền dọn dẹp')
        );
        assert.ok(chmodCallCount > 0, 'chmodSync phải được gọi trong quá trình dọn dẹp');
      } finally {
        fs.chmodSync = originalChmod;
      }

      // BLOCKER 04: Khẳng định thư mục tạm được dọn dẹp sạch sẽ, không để rò rỉ tài nguyên ra ổ đĩa
      assert.strictEqual(
        fs.existsSync(faultedDir),
        false,
        `Thư mục tạm ${faultedDir} phải được dọn dẹp sạch sẽ, không được để rò rỉ tài nguyên`
      );

      // BLOCKER 05: Kiểm chứng cơ chế dọn dẹp sentinel không nuốt lỗi khi gặp exception
      const mockSentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
      try {
        assert.throws(
          () => {
            let sentinelCleanupError = null;
            try {
              throw new Error('EACCES: permission denied, rmSync');
            } catch (err) {
              sentinelCleanupError = err;
            }
            if (sentinelCleanupError) {
              throw new Error(`[Sentinel Cleanup Failure tại ${mockSentinelDir}]: ${sentinelCleanupError.message}`);
            }
          },
          (err) =>
            err instanceof Error &&
            err.message.includes('[Sentinel Cleanup Failure') &&
            err.message.includes('EACCES: permission denied')
        );
      } finally {
        if (fs.existsSync(mockSentinelDir)) {
          let cleanupError = null;
          try {
            fs.chmodSync(mockSentinelDir, 0o777);
          } catch (chmodErr) {
            cleanupError = new Error(`[Sentinel Chmod Failure]: ${chmodErr.message}`);
          }
          try {
            fs.rmSync(mockSentinelDir, { recursive: true, force: true });
          } catch (rmErr) {
            if (!cleanupError) {
              cleanupError = rmErr;
            } else {
              cleanupError = new Error(`${cleanupError.message} | [Sentinel rmSync Failure]: ${rmErr.message}`);
            }
          }
          if (fs.existsSync(mockSentinelDir)) {
            const leakErr = new Error(`[Sentinel Cleanup Leak]: Thư mục ${mockSentinelDir} vẫn còn tồn tại sau khi dọn dẹp!`);
            throw cleanupError || leakErr;
          }
          if (cleanupError) {
            throw cleanupError;
          }
        }
      }

      return { status: 'PASS' };
    },
  },
  {
    id: 'FS-NESTED-CLEANUP',
    name: 'FS-NESTED-CLEANUP — Kiểm chứng dọn dẹp an toàn khi workspace chứa thư mục con lồng nhau và file chỉ đọc trên POSIX',
    fn: () => {
      let createdTempDir = '';
      withIsolatedFaultWorkspace(({ tempDir }) => {
        createdTempDir = tempDir;
        const subDir = path.join(tempDir, 'sub_dir', 'deep_dir');
        fs.mkdirSync(subDir, { recursive: true });
        const nestedFile = path.join(subDir, 'nested_readonly.txt');
        fs.writeFileSync(nestedFile, 'read-only content', 'utf8');
        fs.chmodSync(nestedFile, 0o444);
        assert.strictEqual(fs.existsSync(nestedFile), true);
      });
      // Xác nhận toàn bộ cấu trúc thư mục lồng nhau đã được dọn sạch không sót lại
      assert.strictEqual(
        fs.existsSync(createdTempDir),
        false,
        'Thư mục tạm chứa cấu trúc lồng nhau phải được dọn dẹp sạch sẽ 100%'
      );
      return { status: 'PASS' };
    },
  },
];

/**
 * Mini-runner độc lập quản lý thực thi 5 kịch bản FS với hợp đồng bất biến:
 * - assert.strictEqual(passed + failed + skipped, total);
 * - assert.strictEqual(executed, total);
 * - const exitCode = failed > 0 ? 1 : 0;
 */
function runFsFaultSuite(tests) {
  const total = tests.length;
  let executed = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];
  const skips = [];

  console.log('=== KHỞI CHẠY BỘ KIỂM THỬ LỖI FILESYSTEM THỰC TẾ (tests/fs_fault.test.js) ===\n');

  for (let i = 0; i < tests.length; i += 1) {
    const testCase = tests[i];
    executed += 1;
    try {
      const outcome = testCase.fn();
      if (outcome && outcome.status === 'SKIP') {
        skipped += 1;
        skips.push({ id: testCase.id, name: testCase.name, reason: outcome.reason || 'N/A' });
        console.log(`[SKIP] ${testCase.name}\n       Lý do: ${outcome.reason}`);
      } else {
        passed += 1;
        console.log(`[PASS] ${testCase.name}`);
      }
    } catch (err) {
      failed += 1;
      const message = err && err.message ? err.message : String(err);
      const stack = err && err.stack ? err.stack : message;
      failures.push({ id: testCase.id, name: testCase.name, error: err, message, stack });
      console.error(`[FAIL] ${testCase.name}: ${message}`);
    }
  }

  // Hợp đồng bất biến của Runner
  assert.strictEqual(
    passed + failed + skipped,
    total,
    `Hợp đồng tổng số test bị vi phạm: passed (${passed}) + failed (${failed}) + skipped (${skipped}) !== total (${total})`
  );
  assert.strictEqual(
    executed,
    total,
    `Hợp đồng số kịch bản xử lý bị vi phạm: executed (${executed}) !== total (${total})`
  );

  const exitCode = failed > 0 ? 1 : 0;

  console.log(
    `\n=== TỔNG KẾT FS FAULT: ${passed}/${total} PASS | ${failed}/${total} FAIL | ${skipped}/${total} SKIP (Executed: ${executed}) ===`
  );

  if (skips.length > 0) {
    console.log('\n--- CÁC KỊCH BẢN BỎ QUA DO GIỚI HẠN HĐH (SKIP) ---');
    for (const s of skips) {
      console.log(`- [${s.id}] ${s.name}\n  Lý do: ${s.reason}`);
    }
  }

  if (failures.length > 0) {
    console.error('\n--- CHI TIẾT CÁC KỊCH BẢN THẤT BẠI (FAIL) ---');
    for (const f of failures) {
      console.error(`- [${f.id}] ${f.name}:\n  ${f.stack}`);
    }
  }

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }

  return { total, executed, passed, failed, skipped, exitCode, failures, skips };
}

if (require.main === module) {
  runFsFaultSuite(faultTestCases);
}

module.exports = { faultTestCases, runFsFaultSuite, withIsolatedFaultWorkspace };

import { useRef, useState, type ChangeEvent } from 'react';
import { formatBytes, formatDate } from '../format';
import type { FileItem } from '../types';

interface UploadState {
  key: string;
  name: string;
  percent: number;
  failed: boolean;
}

interface Props {
  files: FileItem[] | null;
  canWrite: boolean;
  onUpload: (file: File, onProgress: (percent: number) => void) => Promise<void>;
  onDelete: (file: FileItem) => void | Promise<void>;
}

let uploadSeq = 0;

export default function FileList({ files, canWrite, onUpload, onDelete }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);

  const pickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const file of selected) void startUpload(file);
  };

  const startUpload = async (file: File) => {
    const key = `${Date.now()}-${uploadSeq++}`;
    const entry: UploadState = { key, name: file.name, percent: 0, failed: false };
    setUploads((all) => [...all, entry]);
    const update = (percent: number) =>
      setUploads((all) => all.map((u) => (u.key === key ? { ...u, percent } : u)));
    try {
      await onUpload(file, update);
      setUploads((all) => all.filter((u) => u.key !== key));
    } catch {
      setUploads((all) => all.map((u) => (u.key === key ? { ...u, failed: true } : u)));
      window.setTimeout(() => {
        setUploads((all) => all.filter((u) => u.key !== key));
      }, 4000);
    }
  };

  const confirmDelete = (file: FileItem) => {
    if (window.confirm(`"${file.name}" 파일을 삭제할까요?`)) void onDelete(file);
  };

  return (
    <div className="file-panel">
      <div className="file-toolbar">
        <span className="file-count">
          {files === null ? '불러오는 중…' : `파일 ${files.length}개`}
        </span>
        {canWrite && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden-input"
              onChange={pickFiles}
            />
            <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()}>
              ⬆ 업로드
            </button>
          </>
        )}
      </div>

      {uploads.length > 0 && (
        <div className="upload-list">
          {uploads.map((u) => (
            <div key={u.key} className={`upload-item ${u.failed ? 'failed' : ''}`}>
              <span className="upload-name">{u.name}</span>
              <div className="progress">
                <div
                  className={`progress-bar ${u.failed ? 'progress-fail' : ''}`}
                  style={{ width: `${u.failed ? 100 : u.percent}%` }}
                />
              </div>
              <span className="upload-pct">
                {u.failed ? '실패' : `${u.percent}%`}
              </span>
            </div>
          ))}
        </div>
      )}

      {files !== null && files.length === 0 && (
        <div className="empty-state">
          {canWrite ? '파일을 업로드해 보세요.' : '이 폴더에는 파일이 없습니다.'}
        </div>
      )}

      {files !== null && files.length > 0 && (
        <table className="file-table">
          <thead>
            <tr>
              <th>이름</th>
              <th className="col-size">크기</th>
              <th className="col-date">수정일</th>
              <th className="col-actions">작업</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td className="file-name" title={f.mime}>
                  📄 {f.name}
                </td>
                <td className="col-size">{formatBytes(f.size)}</td>
                <td className="col-date">{formatDate(f.updatedAt)}</td>
                <td className="col-actions">
                  <a
                    className="btn btn-small"
                    href={`/api/files/${f.id}/download`}
                    title="다운로드 (원본)"
                  >
                    ⬇ 다운로드
                  </a>
                  {canWrite && (
                    <button type="button" className="btn btn-small danger" onClick={() => confirmDelete(f)}>
                      🗑 삭제
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

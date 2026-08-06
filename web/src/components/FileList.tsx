import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { isAbortError } from '../api';
import { formatBytes, formatDate } from '../format';
import { langToLocale, useI18n } from '../i18n';
import type { FileItem, FolderNode } from '../types';
import MoveModal from './MoveModal';

type UploadState = 'queued' | 'uploading' | 'failed';

interface UploadEntry {
  key: string;
  name: string;
  percent: number;
  state: UploadState;
  controller: AbortController;
  file: File;
}

interface Props {
  files: FileItem[] | null;
  subFolders: FolderNode[];
  searchMode: boolean;
  searching: boolean;
  searchResults: FileItem[] | null;
  onOpenFolder: (id: string) => void;
  onOpenSearchFolder: (folderId: string | null) => void;
  canWrite: boolean;
  folders: FolderNode[];
  onUpload: (
    file: File,
    onProgress: (percent: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  onDelete: (file: FileItem) => void | Promise<void>;
  onMove: (file: FileItem, folderId: string | null) => Promise<void>;
}

let uploadSeq = 0;

export default function FileList({
  files,
  subFolders,
  searchMode,
  searching,
  searchResults,
  onOpenFolder,
  onOpenSearchFolder,
  canWrite,
  folders,
  onUpload,
  onDelete,
  onMove,
}: Props) {
  const { lang, t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [moveTarget, setMoveTarget] = useState<FileItem | null>(null);
  const uploadsRef = useRef<UploadEntry[]>([]);
  const runningRef = useRef(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  // Sequential upload queue: starts the first queued entry whenever the queue
  // changes and no upload is currently running.
  const startNext = useCallback(async () => {
    if (runningRef.current) return;
    const next = uploadsRef.current.find((u) => u.state === 'queued');
    if (!next) return;
    runningRef.current = true;
    setUploads((all) =>
      all.map((u) => (u.key === next.key ? { ...u, state: 'uploading' as const } : u)),
    );
    try {
      await onUpload(
        next.file,
        (percent) => {
          setUploads((all) => all.map((u) => (u.key === next.key ? { ...u, percent } : u)));
        },
        next.controller.signal,
      );
      setUploads((all) => all.filter((u) => u.key !== next.key));
    } catch (err) {
      if (isAbortError(err)) {
        setUploads((all) => all.filter((u) => u.key !== next.key));
      } else {
        setUploads((all) =>
          all.map((u) => (u.key === next.key ? { ...u, state: 'failed' as const } : u)),
        );
        window.setTimeout(() => {
          setUploads((all) => all.filter((u) => u.key !== next.key));
        }, 4000);
      }
    } finally {
      runningRef.current = false;
    }
  }, [onUpload]);

  useEffect(() => {
    void startNext();
  }, [uploads, startNext]);

  const enqueueFiles = useCallback((fileList: File[]) => {
    if (fileList.length === 0) return;
    const entries: UploadEntry[] = fileList.map((file) => ({
      key: `${Date.now()}-${uploadSeq++}`,
      name: file.name,
      percent: 0,
      state: 'queued',
      controller: new AbortController(),
      file,
    }));
    setUploads((all) => [...all, ...entries]);
  }, []);

  const cancelUpload = useCallback((key: string) => {
    const entry = uploadsRef.current.find((u) => u.key === key);
    if (!entry) return;
    if (entry.state === 'queued') {
      setUploads((all) => all.filter((u) => u.key !== key));
    } else if (entry.state === 'uploading') {
      entry.controller.abort();
    }
  }, []);

  const pickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = '';
    enqueueFiles(selected);
  };

  const handleDragEnter = (e: DragEvent) => {
    if (!canWrite || searchMode) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };

  const handleDragOver = (e: DragEvent) => {
    if (!canWrite || searchMode) return;
    e.preventDefault();
  };

  const handleDragLeave = (e: DragEvent) => {
    if (!canWrite || searchMode) return;
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  };

  const handleDrop = (e: DragEvent) => {
    if (!canWrite || searchMode) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    enqueueFiles(Array.from(e.dataTransfer.files));
  };

  const confirmDelete = (file: FileItem) => {
    if (window.confirm(t('file.deleteConfirm', { name: file.name }))) void onDelete(file);
  };

  const rows = searchMode ? searchResults : files;

  return (
    <div
      className="file-panel"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="file-toolbar">
        <span className="file-count">
          {searchMode
            ? searching
              ? t('common.loading')
              : t('search.results', { count: searchResults?.length ?? 0 })
            : files === null
              ? t('common.loading')
              : t('file.count', { folders: subFolders.length, files: files.length })}
        </span>
        {canWrite && !searchMode && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden-input"
              onChange={pickFiles}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => inputRef.current?.click()}
            >
              {t('file.upload')}
            </button>
          </>
        )}
      </div>

      {uploads.length > 0 && (
        <div className="upload-list">
          {uploads.map((u) => (
            <div key={u.key} className={`upload-item ${u.state === 'failed' ? 'failed' : ''}`}>
              <span className="upload-name">{u.name}</span>
              <div className="progress">
                <div
                  className={`progress-bar ${u.state === 'failed' ? 'progress-fail' : ''}`}
                  style={{ width: `${u.state === 'failed' ? 100 : u.percent}%` }}
                />
              </div>
              <span className="upload-pct">
                {u.state === 'failed'
                  ? t('file.uploadFailedShort')
                  : u.state === 'queued'
                    ? t('upload.queued')
                    : `${u.percent}%`}
              </span>
              {u.state !== 'failed' && (
                <button
                  type="button"
                  className="upload-cancel"
                  title={t('upload.cancelTitle')}
                  onClick={() => cancelUpload(u.key)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!searchMode && subFolders.length > 0 && (
        <div className="folder-section">
          {subFolders.map((f) => (
            <button
              key={f.id}
              type="button"
              className="folder-row"
              onClick={() => onOpenFolder(f.id)}
            >
              <span aria-hidden>📁</span>
              <span className="folder-name" title={f.name}>
                {f.name}
              </span>
              <span className={`role-badge ${f.role === 'admin' ? 'admin' : ''}`}>{f.role}</span>
            </button>
          ))}
        </div>
      )}

      {rows !== null && rows.length === 0 && (searchMode || subFolders.length === 0) && (
        <div className="empty-state">
          {searchMode ? t('search.noResults') : canWrite ? t('file.emptyWrite') : t('file.emptyRead')}
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <table className="file-table">
          <thead>
            <tr>
              <th>{t('file.nameCol')}</th>
              <th className="col-size">{t('file.sizeCol')}</th>
              <th className="col-date">{t('file.dateCol')}</th>
              <th className="col-actions">{t('file.actionsCol')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id}>
                <td className="file-name" title={f.mime}>
                  {searchMode ? (
                    <button
                      type="button"
                      className="file-link"
                      onClick={() => onOpenSearchFolder(f.folderId)}
                    >
                      📄 {f.name}
                    </button>
                  ) : (
                    <span>📄 {f.name}</span>
                  )}
                  {searchMode && f.folderPath && f.folderPath.length > 0 && (
                    <span className="folder-path">
                      {f.folderPath.map((seg, i) => (
                        <span key={seg.id}>
                          {i > 0 && <span className="crumb-sep">/</span>}
                          <button
                            type="button"
                            className="folder-path-link"
                            onClick={() => onOpenSearchFolder(seg.id)}
                          >
                            {seg.name}
                          </button>
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="col-size">{formatBytes(f.size)}</td>
                <td className="col-date">{formatDate(f.updatedAt, langToLocale(lang))}</td>
                <td className="col-actions">
                  <a
                    className="btn btn-small"
                    href={`/api/files/${f.id}/download`}
                    title={t('file.downloadTitle')}
                  >
                    {t('file.download')}
                  </a>
                  {canWrite && !searchMode && (
                    <>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setMoveTarget(f)}
                      >
                        {t('file.move')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-small danger"
                        onClick={() => confirmDelete(f)}
                      >
                        🗑 {t('common.delete')}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dragOver && (
        <div className="drop-overlay">
          <span>{t('upload.dropHint')}</span>
        </div>
      )}

      {moveTarget !== null && (
        <MoveModal
          key={moveTarget.id}
          file={moveTarget}
          folders={folders}
          onClose={() => setMoveTarget(null)}
          onMove={async (file, folderId) => {
            await onMove(file, folderId);
            setMoveTarget(null);
          }}
        />
      )}
    </div>
  );
}

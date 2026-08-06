import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { isAbortError } from '../api';
import { cn } from '../cn';
import { formatBytes, formatDate } from '../format';
import { langToLocale, useI18n } from '../i18n';
import { btn, btnDanger, btnPrimary, btnSmall, roleBadge, roleBadgeAdmin } from '../ui';
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
      className="relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-xs text-muted">
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
              className="hidden"
              onChange={pickFiles}
            />
            <button
              type="button"
              className={`${btn} ${btnPrimary}`}
              onClick={() => inputRef.current?.click()}
            >
              {t('file.upload')}
            </button>
          </>
        )}
      </div>

      {uploads.length > 0 && (
        <div className="mb-2.5 flex flex-col gap-1.5">
          {uploads.map((u) => (
            <div key={u.key} className={cn('flex items-center gap-2 text-xs', u.state === 'failed' && 'text-danger')}>
              <span className="w-40 truncate">{u.name}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-track">
                <div
                  className={cn('h-full bg-accent transition-[width] duration-150 ease-out', u.state === 'failed' && 'bg-danger')}
                  style={{ width: `${u.state === 'failed' ? 100 : u.percent}%` }}
                />
              </div>
              <span className={cn('w-11 text-right', u.state !== 'failed' && 'text-muted')}>
                {u.state === 'failed'
                  ? t('file.uploadFailedShort')
                  : u.state === 'queued'
                    ? t('upload.queued')
                    : `${u.percent}%`}
              </span>
              {u.state !== 'failed' && (
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 text-xs leading-none text-muted hover:text-danger"
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
        <div className="mb-2.5 flex flex-col overflow-hidden rounded-lg border border-border">
          {subFolders.map((f) => (
            <button
              key={f.id}
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 border-0 border-b border-[#eef2f5] bg-row-alt px-2.5 py-[7px] text-left text-sm last:border-b-0 hover:bg-row-hover"
              onClick={() => onOpenFolder(f.id)}
            >
              <span aria-hidden>📁</span>
              <span className="flex-1 truncate font-semibold" title={f.name}>
                {f.name}
              </span>
              <span className={cn(roleBadge, f.role === 'admin' && roleBadgeAdmin)}>
                {t(`role.${f.role}`)}
              </span>
            </button>
          ))}
        </div>
      )}

      {rows !== null && rows.length === 0 && (searchMode || subFolders.length === 0) && (
        <div className="py-10 text-center text-muted">
          {searchMode ? t('search.noResults') : canWrite ? t('file.emptyWrite') : t('file.emptyRead')}
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <table className="w-full min-w-0 table-fixed border-collapse">
          <thead>
            <tr>
              <th className="border-b border-border px-2 py-1.5 text-left text-xs font-semibold text-muted">{t('file.nameCol')}</th>
              <th className="hidden w-[90px] border-b border-border px-2 py-1.5 text-left text-xs font-semibold text-muted sm:table-cell">{t('file.sizeCol')}</th>
              <th className="hidden w-[160px] border-b border-border px-2 py-1.5 text-left text-xs font-semibold text-muted md:table-cell">{t('file.dateCol')}</th>
              <th className="w-[205px] min-w-[205px] border-b border-border px-2 py-1.5 text-right text-xs font-semibold text-muted">{t('file.actionsCol')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} className="hover:bg-[#f8fafc]">
                <td className="truncate border-b border-[#eef2f5] px-2 py-[7px] align-middle" title={f.mime}>
                  {searchMode ? (
                    <button
                      type="button"
                      className="cursor-pointer border-0 bg-transparent p-0 text-left text-inherit hover:underline"
                      onClick={() => onOpenSearchFolder(f.folderId)}
                    >
                      📄 {f.name}
                    </button>
                  ) : (
                    <span>📄 {f.name}</span>
                  )}
                  {searchMode && f.folderPath && f.folderPath.length > 0 && (
                    <span className="mt-0.5 flex flex-wrap items-center gap-0.5 text-[11px] text-muted">
                      {f.folderPath.map((seg, i) => (
                        <span key={seg.id}>
                          {i > 0 && <span className="text-muted">/</span>}
                          <button
                            type="button"
                            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-accent hover:underline"
                            onClick={() => onOpenSearchFolder(seg.id)}
                          >
                            {seg.name}
                          </button>
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="hidden border-b border-[#eef2f5] px-2 py-[7px] align-middle sm:table-cell">{formatBytes(f.size)}</td>
                <td className="hidden border-b border-[#eef2f5] px-2 py-[7px] align-middle md:table-cell">{formatDate(f.updatedAt, langToLocale(lang))}</td>
                <td className="w-[205px] min-w-[205px] border-b border-[#eef2f5] px-2 py-[7px] text-right align-middle">
                  <div className="flex flex-nowrap justify-end gap-1 whitespace-nowrap">
                    <a
                      className={`${btn} ${btnSmall}`}
                      href={`/api/files/${f.id}/download`}
                      title={t('file.downloadTitle')}
                    >
                      {t('file.download')}
                    </a>
                    {canWrite && !searchMode && (
                      <>
                        <button type="button" className={`${btn} ${btnSmall}`} onClick={() => setMoveTarget(f)}>
                          {t('file.move')}
                        </button>
                        <button type="button" className={`${btn} ${btnSmall} ${btnDanger}`} onClick={() => confirmDelete(f)}>
                          🗑 {t('common.delete')}
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-[rgba(37,99,235,0.08)] font-semibold text-accent-dark">
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

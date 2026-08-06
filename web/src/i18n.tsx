/**
 * Lightweight i18n for the SPA — no external dependencies.
 *
 * - Languages: ko (default), en, ja
 * - Preference is persisted in localStorage (`telegram-storage.lang`)
 * - <html lang> is kept in sync
 * - t(key, vars) interpolates {var} placeholders
 *
 * `t` is also exported as a plain module function so non-React modules
 * (e.g. api.ts) can translate; I18nProvider keeps the module-level current
 * language in sync with React state.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export type Lang = 'ko' | 'en' | 'ja';

export const LANG_LABELS: Record<Lang, string> = {
  ko: '한국어',
  en: 'English',
  ja: '日本語',
};

const STORAGE_KEY = 'telegram-storage.lang';

/** Map a Lang to a BCP-47 locale tag (used by date/number formatting). */
export function langToLocale(lang: Lang): string {
  switch (lang) {
    case 'en':
      return 'en-US';
    case 'ja':
      return 'ja-JP';
    default:
      return 'ko-KR';
  }
}

type Vars = Record<string, string | number>;

const messages: Record<Lang, Record<string, string>> = {
  ko: {
    'common.loading': '불러오는 중…',
    'common.retry': '다시 시도',
    'common.close': '닫기',
    'common.cancel': '취소',
    'common.save': '저장',
    'common.create': '만들기',
    'common.delete': '삭제',
    'common.logout': '로그아웃',
    'common.root': '루트',
    'role.read': '읽기',
    'role.write': '쓰기',
    'role.admin': '관리',
    'app.bootFailed': '서버에 연결할 수 없습니다. API 서버가 실행 중인지 확인하세요.',
    'app.authCheckFailed': '인증 상태 확인 실패: {message}',
    'login.subtitle': '팀 파일 저장소',
    'login.notConfiguredIntro': '로그인 방법이 구성되지 않았습니다. 서버에서',
    'login.or': '또는',
    'login.notConfiguredOutro': '을(를) 설정하세요.',
    'login.username': '사용자 이름',
    'login.usernamePlaceholder': '예: alice',
    'login.displayName': '표시 이름 (선택)',
    'login.signIn': '로그인',
    'login.signingIn': '로그인 중…',
    'login.devModeHint': '개발 모드 (DEV_AUTH=true) — 첫 로그인 사용자는 admin이 됩니다.',
    'login.telegramFailed': '텔레그램 로그인에 실패했습니다',
    'login.failed': '로그인에 실패했습니다',
    'login.telegramHint1': '텔레그램 계정으로 로그인하세요.',
    'login.telegramHint2': '(위젯이 표시되지 않으면 @BotFather에서 /setdomain 을 확인하세요)',
    'browser.foldersLoadFailed': '폴더 목록을 불러오지 못했습니다',
    'browser.filesLoadFailed': '파일 목록을 불러오지 못했습니다',
    'browser.permsLoadFailed': '권한 목록을 불러오지 못했습니다',
    'browser.breadcrumbAria': '폴더 경로',
    'browser.gotoFolder': '{name}로 이동',
    'folder.title': '폴더',
    'folder.new': '+ 새 폴더',
    'folder.newTitle': '선택한 폴더 아래에 새 폴더 생성',
    'folder.createAt': '생성 위치: {name}',
    'folder.namePlaceholder': '폴더 이름',
    'folder.empty': '폴더가 없습니다',
    'folder.roleTitle': '권한: {role}',
    'folder.createChildTitle': '하위 폴더 생성',
    'folder.renameTitle': '이름 변경',
    'folder.deleteConfirm': '"{name}" 폴더와 그 안의 모든 하위 폴더/파일을 삭제할까요?',
    'folder.created': '폴더 "{name}" 생성됨',
    'folder.createFailed': '폴더 생성 실패',
    'folder.renamed': '폴더 이름이 변경되었습니다',
    'folder.renameFailed': '폴더 이름 변경 실패',
    'folder.deleted': '폴더가 삭제되었습니다',
    'folder.deleteFailed': '폴더 삭제 실패',
    'file.count': '폴더 {folders} · 파일 {files}개',
    'file.upload': '⬆ 업로드',
    'file.uploadFailedShort': '실패',
    'file.emptyWrite': '폴더를 만들거나 파일을 업로드해 보세요.',
    'file.emptyRead': '이 폴더에는 항목이 없습니다.',
    'file.nameCol': '이름',
    'file.sizeCol': '크기',
    'file.dateCol': '수정일',
    'file.actionsCol': '작업',
    'file.download': '⬇ 다운로드',
    'file.downloadTitle': '다운로드 (원본)',
    'file.deleteConfirm': '"{name}" 파일을 삭제할까요?',
    'file.uploaded': '"{name}" 업로드 완료',
    'file.uploadFailed': '업로드 실패',
    'file.uploadNetworkError': '네트워크 오류로 업로드하지 못했습니다',
    'file.deleted': '"{name}" 삭제됨',
    'file.deleteFailed': '파일 삭제 실패',
    'perm.title': '권한 — {name}',
    'perm.userIdNumeric': '사용자 ID는 숫자여야 합니다',
    'perm.userIdPlaceholder': '사용자 ID (숫자)',
    'perm.grant': '부여',
    'perm.owner': '소유자',
    'perm.ownerTitle': '폴더 소유자는 항상 admin (변경/회수 불가)',
    'perm.changeRole': '역할 변경',
    'perm.revoke': '회수',
    'perm.knownUsers': '알려진 사용자:',
    'perm.knownUsersTitle': '클릭해 부여 폼에 채우기',
    'perm.granted': 'User #{userId} → {role} 권한 부여됨',
    'perm.grantFailed': '권한 부여 실패',
    'perm.revoked': 'User #{userId} 권한 회수됨',
    'perm.revokeFailed': '권한 회수 실패',
    'settings.title': '설정',
    'settings.openTitle': '설정 열기',
    'settings.language': '언어',
  },
  en: {
    'common.loading': 'Loading…',
    'common.retry': 'Retry',
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.create': 'Create',
    'common.delete': 'Delete',
    'common.logout': 'Log out',
    'common.root': 'Root',
    'role.read': 'Read',
    'role.write': 'Write',
    'role.admin': 'Admin',
    'app.bootFailed': 'Cannot reach the server. Please check that the API server is running.',
    'app.authCheckFailed': 'Failed to check auth status: {message}',
    'login.subtitle': 'Team file storage',
    'login.notConfiguredIntro': 'No login method is configured. Set',
    'login.or': 'or',
    'login.notConfiguredOutro': 'on the server.',
    'login.username': 'Username',
    'login.usernamePlaceholder': 'e.g. alice',
    'login.displayName': 'Display name (optional)',
    'login.signIn': 'Sign in',
    'login.signingIn': 'Signing in…',
    'login.devModeHint': 'Dev mode (DEV_AUTH=true) — the first user to sign in becomes admin.',
    'login.telegramFailed': 'Telegram sign-in failed',
    'login.failed': 'Sign-in failed',
    'login.telegramHint1': 'Sign in with your Telegram account.',
    'login.telegramHint2': "(If the widget doesn't appear, check /setdomain in @BotFather)",
    'browser.foldersLoadFailed': 'Failed to load the folder list',
    'browser.filesLoadFailed': 'Failed to load the file list',
    'browser.permsLoadFailed': 'Failed to load permissions',
    'browser.breadcrumbAria': 'Folder path',
    'browser.gotoFolder': 'Go to {name}',
    'folder.title': 'Folders',
    'folder.new': '+ New folder',
    'folder.newTitle': 'Create a new folder under the selected folder',
    'folder.createAt': 'Location: {name}',
    'folder.namePlaceholder': 'Folder name',
    'folder.empty': 'No folders yet',
    'folder.roleTitle': 'Role: {role}',
    'folder.createChildTitle': 'Create subfolder',
    'folder.renameTitle': 'Rename',
    'folder.deleteConfirm': 'Delete the folder "{name}" and all folders/files inside it?',
    'folder.created': 'Folder "{name}" created',
    'folder.createFailed': 'Failed to create folder',
    'folder.renamed': 'Folder renamed',
    'folder.renameFailed': 'Failed to rename folder',
    'folder.deleted': 'Folder deleted',
    'folder.deleteFailed': 'Failed to delete folder',
    'file.count': '{folders} folders · {files} files',
    'file.upload': '⬆ Upload',
    'file.uploadFailedShort': 'Failed',
    'file.emptyWrite': 'Create a folder or upload a file to get started.',
    'file.emptyRead': 'This folder is empty.',
    'file.nameCol': 'Name',
    'file.sizeCol': 'Size',
    'file.dateCol': 'Modified',
    'file.actionsCol': 'Actions',
    'file.download': '⬇ Download',
    'file.downloadTitle': 'Download (original)',
    'file.deleteConfirm': 'Delete the file "{name}"?',
    'file.uploaded': '"{name}" uploaded',
    'file.uploadFailed': 'Upload failed',
    'file.uploadNetworkError': 'Could not upload due to a network error',
    'file.deleted': '"{name}" deleted',
    'file.deleteFailed': 'Failed to delete file',
    'perm.title': 'Permissions — {name}',
    'perm.userIdNumeric': 'User ID must be numeric',
    'perm.userIdPlaceholder': 'User ID (numeric)',
    'perm.grant': 'Grant',
    'perm.owner': 'Owner',
    'perm.ownerTitle': 'The folder owner is always admin (cannot be changed or revoked)',
    'perm.changeRole': 'Change role',
    'perm.revoke': 'Revoke',
    'perm.knownUsers': 'Known users:',
    'perm.knownUsersTitle': 'Click to fill the grant form',
    'perm.granted': 'Granted {role} to User #{userId}',
    'perm.grantFailed': 'Failed to grant permission',
    'perm.revoked': 'Revoked permission for User #{userId}',
    'perm.revokeFailed': 'Failed to revoke permission',
    'settings.title': 'Settings',
    'settings.openTitle': 'Open settings',
    'settings.language': 'Language',
  },
  ja: {
    'common.loading': '読み込み中…',
    'common.retry': '再試行',
    'common.close': '閉じる',
    'common.cancel': 'キャンセル',
    'common.save': '保存',
    'common.create': '作成',
    'common.delete': '削除',
    'common.logout': 'ログアウト',
    'common.root': 'ルート',
    'role.read': '閲覧',
    'role.write': '編集',
    'role.admin': '管理者',
    'app.bootFailed': 'サーバーに接続できません。APIサーバーが起動しているか確認してください。',
    'app.authCheckFailed': '認証状態の確認に失敗しました: {message}',
    'login.subtitle': 'チームファイルストレージ',
    'login.notConfiguredIntro': 'ログイン方法が設定されていません。サーバーで',
    'login.or': 'または',
    'login.notConfiguredOutro': 'を設定してください。',
    'login.username': 'ユーザー名',
    'login.usernamePlaceholder': '例: alice',
    'login.displayName': '表示名（任意）',
    'login.signIn': 'ログイン',
    'login.signingIn': 'ログイン中…',
    'login.devModeHint': '開発モード（DEV_AUTH=true）— 最初にログインしたユーザーが管理者になります。',
    'login.telegramFailed': 'Telegramログインに失敗しました',
    'login.failed': 'ログインに失敗しました',
    'login.telegramHint1': 'Telegramアカウントでログインしてください。',
    'login.telegramHint2': '（ウィジェットが表示されない場合は @BotFather で /setdomain を確認してください）',
    'browser.foldersLoadFailed': 'フォルダ一覧を読み込めませんでした',
    'browser.filesLoadFailed': 'ファイル一覧を読み込めませんでした',
    'browser.permsLoadFailed': '権限一覧を読み込めませんでした',
    'browser.breadcrumbAria': 'フォルダのパス',
    'browser.gotoFolder': '{name} へ移動',
    'folder.title': 'フォルダ',
    'folder.new': '+ 新しいフォルダ',
    'folder.newTitle': '選択したフォルダの下に新しいフォルダを作成',
    'folder.createAt': '作成場所: {name}',
    'folder.namePlaceholder': 'フォルダ名',
    'folder.empty': 'フォルダがありません',
    'folder.roleTitle': '権限: {role}',
    'folder.createChildTitle': 'サブフォルダを作成',
    'folder.renameTitle': '名前を変更',
    'folder.deleteConfirm': 'フォルダ「{name}」とその中のすべてのフォルダ・ファイルを削除しますか？',
    'folder.created': 'フォルダ「{name}」を作成しました',
    'folder.createFailed': 'フォルダの作成に失敗しました',
    'folder.renamed': 'フォルダ名を変更しました',
    'folder.renameFailed': 'フォルダ名の変更に失敗しました',
    'folder.deleted': 'フォルダを削除しました',
    'folder.deleteFailed': 'フォルダの削除に失敗しました',
    'file.count': 'フォルダ {folders} · ファイル {files}件',
    'file.upload': '⬆ アップロード',
    'file.uploadFailedShort': '失敗',
    'file.emptyWrite': 'フォルダを作成するか、ファイルをアップロードしてください。',
    'file.emptyRead': 'このフォルダには項目がありません。',
    'file.nameCol': '名前',
    'file.sizeCol': 'サイズ',
    'file.dateCol': '更新日',
    'file.actionsCol': '操作',
    'file.download': '⬇ ダウンロード',
    'file.downloadTitle': 'ダウンロード（元ファイル）',
    'file.deleteConfirm': 'ファイル「{name}」を削除しますか？',
    'file.uploaded': '「{name}」をアップロードしました',
    'file.uploadFailed': 'アップロードに失敗しました',
    'file.uploadNetworkError': 'ネットワークエラーによりアップロードできませんでした',
    'file.deleted': '「{name}」を削除しました',
    'file.deleteFailed': 'ファイルの削除に失敗しました',
    'perm.title': '権限 — {name}',
    'perm.userIdNumeric': 'ユーザーIDは数字である必要があります',
    'perm.userIdPlaceholder': 'ユーザーID（数字）',
    'perm.grant': '付与',
    'perm.owner': '所有者',
    'perm.ownerTitle': 'フォルダの所有者は常に管理者（変更・取り消し不可）',
    'perm.changeRole': '役割を変更',
    'perm.revoke': '取り消し',
    'perm.knownUsers': '既知のユーザー:',
    'perm.knownUsersTitle': 'クリックして付与フォームに入力',
    'perm.granted': 'User #{userId} に {role} を付与しました',
    'perm.grantFailed': '権限の付与に失敗しました',
    'perm.revoked': 'User #{userId} の権限を取り消しました',
    'perm.revokeFailed': '権限の取り消しに失敗しました',
    'settings.title': '設定',
    'settings.openTitle': '設定を開く',
    'settings.language': '言語',
  },
};

// Module-level current language so non-React modules (e.g. api.ts) can
// translate too. I18nProvider keeps this in sync with React state.
let currentLang: Lang = 'ko';

function loadLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ko' || saved === 'en' || saved === 'ja') return saved;
  } catch {
    // localStorage unavailable — fall through to browser language
  }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : '')?.toLowerCase() ?? '';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('en')) return 'en';
  return 'ko';
}

function interpolate(msg: string, vars?: Vars): string {
  if (!vars) return msg;
  let out = msg;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out;
}

/** Translate a key for the current language (usable outside React too). */
export function t(key: string, vars?: Vars): string {
  const msg = messages[currentLang][key] ?? messages.ko[key] ?? key;
  return interpolate(msg, vars);
}

interface I18nApi {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: typeof t;
}

const I18nContext = createContext<I18nApi | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const initial = loadLang();
    currentLang = initial;
    return initial;
  });

  const setLang = useCallback((next: Lang) => {
    currentLang = next;
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // persistence is best-effort
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const api: I18nApi = { lang, setLang, t };

  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nApi {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>');
  return ctx;
}

export function useT(): typeof t {
  return useI18n().t;
}

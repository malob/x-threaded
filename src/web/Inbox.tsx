import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthStatus, SyncResponse } from "../shared/types";
import {
  useAuthStatus,
  useClearBookmarkFolder,
  useDisconnectX,
  useFolders,
  useOwnPosts,
  useRemoveSaved,
  useSaved,
  useSettings,
  useSwitchBookmarkFolder,
  useSyncBookmarks,
  DEFAULT_OWN_POSTS_SCAN,
  initialOwnPostsScan,
  rememberOwnPostsScan,
  type OwnPostsScan,
} from "./queries";
import type { BookmarkDisposition } from "./api";
import { PostView } from "./PostView";
import { estimateFetchUsd, formatUsd } from "../shared/pricing";
import { xPostUrl } from "../shared/urls";
import {
  authReturnNotice,
  authLoginUrl,
  createSingleFlight,
  folderCostNotice,
  folderSelectionPrompt,
  folderSettingsState,
  lifecyclePromptCopy,
  ownPostsContinuation,
  reconcileAccountTab,
  verifiedAccountGeneration,
  type AccountTabState,
  type AuthReturnNotice,
  type FolderSettingsState,
  type InboxTab,
  type LifecyclePrompt,
} from "./inbox-state";

const DIALOG_TITLE_ID = "lifecycle-dialog-title";
const DIALOG_DETAIL_ID = "lifecycle-dialog-detail";
const BOOKMARK_FOLDER_CONTROL_ID = "bookmark-folder-control";
const RECONNECT_CONTROL_ID = "x-reconnect-control";
const DISCONNECT_CONTROL_ID = "x-disconnect-control";

type SwitchFolderPrompt = Extract<LifecyclePrompt, { kind: "switch-folder" }>;

/**
 * Native modal behavior supplies focus containment and Escape handling. Cancel
 * receives initial focus so a destructive choice is never the keyboard default.
 */
function LifecycleDialog({
  prompt,
  onCancel,
  onSwitchFolder,
  onDisposition,
  onReconnect,
}: {
  prompt: LifecyclePrompt;
  onCancel: () => void;
  onSwitchFolder: (prompt: SwitchFolderPrompt) => void;
  onDisposition: (disposition: BookmarkDisposition) => void;
  onReconnect: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const copy = lifecyclePromptCopy(prompt);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus?.focus();
      else {
        const fallbackId =
          prompt.kind === "switch-folder" || prompt.kind === "clear-folder"
            ? BOOKMARK_FOLDER_CONTROL_ID
            : prompt.kind === "reconnect"
              ? RECONNECT_CONTROL_ID
              : DISCONNECT_CONTROL_ID;
        document.getElementById(fallbackId)?.focus();
      }
    };
  }, [prompt]);

  const cancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      className="lifecycle-dialog"
      aria-modal="true"
      aria-labelledby={DIALOG_TITLE_ID}
      aria-describedby={DIALOG_DETAIL_ID}
      onCancel={cancel}
    >
      <h2 id={DIALOG_TITLE_ID}>{copy.title}</h2>
      <p id={DIALOG_DETAIL_ID}>{copy.detail}</p>
      <div className="dialog-actions">
        {prompt.kind === "switch-folder" && (
          <button type="button" onClick={() => onSwitchFolder(prompt)}>
            {prompt.fromName ? "Switch and sync" : "Start sync"}
          </button>
        )}
        {prompt.kind === "clear-folder" && (
          <>
            <button type="button" onClick={() => onDisposition("keep")}>
              Keep as local saves
            </button>
            <button type="button" onClick={() => onDisposition("remove")}>
              Remove from this app
            </button>
          </>
        )}
        {prompt.kind === "disconnect" && (
          <>
            <button type="button" onClick={() => onDisposition("keep")}>
              Disconnect and keep local saves
            </button>
            <button type="button" onClick={() => onDisposition("remove")}>
              Disconnect and remove synced saves
            </button>
          </>
        )}
        {prompt.kind === "reconnect" && (
          <button type="button" onClick={onReconnect}>
            Continue reconnecting
          </button>
        )}
        <button ref={cancelRef} type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

/**
 * Whether opening this card costs anything, shown so clicking is informed
 * consent — inbox clicks fetch straight away rather than prompting.
 *
 * A loaded conversation is cheap, not free: opening one on a new UTC calendar
 * day refreshes it, and that read bills. So the tag says what we know — the
 * conversation is here — and stops short of a promise the click can't keep.
 */
function FetchCost({ loaded, replyCount }: { loaded: boolean; replyCount: number }) {
  if (loaded) return <span className="cost-tag cost-free">loaded</span>;
  return (
    <span className="cost-tag" title="Estimated from the reply count; the real total is usually within about 30%">
      unfetched · {formatUsd(estimateFetchUsd(replyCount))}
    </span>
  );
}

function connectedAccountLabel(auth: AuthStatus | undefined): string {
  return auth?.state === "authorized" && auth.user
    ? `@${auth.user.username}`
    : "your existing X account";
}

/** X connection controls, separated from the local reading library. */
function ConnectPrompt({
  auth,
  busy,
  onConnect,
  onReconnect,
  onDisconnect,
}: {
  auth: AuthStatus | undefined;
  busy: boolean;
  onConnect: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  // Undefined means we don't know yet, or couldn't find out. Either way this
  // says nothing: claiming "no OAuth credentials" on a failed status call
  // would be an accusation against the deployment, not a fact.
  if (!auth) return null;
  if (auth.state === "unconfigured") {
    return (
      <p className="notice" role="status">
        user-context features are off — this deployment has no OAuth credentials (see
        .env.example)
      </p>
    );
  }
  if (auth.state === "authorized") {
    return (
      <p className="notice" role="status">
        connected to {connectedAccountLabel(auth)} ·{" "}
        <button
          id={RECONNECT_CONTROL_ID}
          className="notice-btn"
          type="button"
          onClick={onReconnect}
          disabled={busy}
        >
          Reconnect
        </button>{" "}
        ·{" "}
        <button
          id={DISCONNECT_CONTROL_ID}
          className="notice-btn"
          type="button"
          onClick={onDisconnect}
          disabled={busy}
        >
          Disconnect X
        </button>
      </p>
    );
  }
  if (auth.state === "disconnecting") {
    return (
      <p className="notice" role="status">
        disconnecting X… account reads are paused ·{" "}
        <button
          id={DISCONNECT_CONTROL_ID}
          className="notice-btn"
          type="button"
          onClick={onDisconnect}
          disabled={busy}
        >
          retry disconnect
        </button>
      </p>
    );
  }
  if (auth.state === "broken") {
    return (
      <p className="notice" role="status">
        <span className="new-badge" title={auth.reason}>
          X session lost
        </span>{" "}
        ·{" "}
        <button
          id={RECONNECT_CONTROL_ID}
          className="notice-btn"
          type="button"
          onClick={onReconnect}
          disabled={busy}
        >
          Reconnect
        </button>{" "}
        ·{" "}
        <button
          id={DISCONNECT_CONTROL_ID}
          className="notice-btn"
          type="button"
          onClick={onDisconnect}
          disabled={busy}
        >
          Disconnect X
        </button>
      </p>
    );
  }
  return (
    <p className="notice" role="status">
      <a className="connect-link" href={auth.loginUrl} onClick={onConnect}>
        Connect your X account
      </a>{" "}
      to sync bookmarks and see your posts
    </p>
  );
}

/** Folder picker plus sync control for the saved tab. */
function FolderBar({
  accountGeneration,
  settingsState,
  onRetrySettings,
  onRequestChange,
  onSync,
  busy,
  syncing,
  syncNote,
}: {
  accountGeneration: string | null;
  settingsState: FolderSettingsState;
  onRetrySettings: () => void;
  onRequestChange: (id: string | null, name: string) => void;
  onSync: () => void;
  busy: boolean;
  syncing: boolean;
  syncNote: string | null;
}) {
  const [picking, setPicking] = useState(false);
  const folders = useFolders(picking, accountGeneration);
  const folderList = folders.data;
  const costNote = folderCostNotice(folderList);

  if (settingsState.kind === "loading") {
    return (
      <p className="notice" role="status">
        loading bookmark settings…
      </p>
    );
  }
  if (settingsState.kind === "error") {
    return (
      <p className="notice" role="alert">
        couldn’t load bookmark settings — {settingsState.message} ·{" "}
        <button className="notice-btn" onClick={onRetrySettings}>
          retry
        </button>
      </p>
    );
  }
  const settings = settingsState.settings;

  if (picking) {
    return (
      <p
        className="notice"
        role={folders.error ? "alert" : !folderList ? "status" : undefined}
      >
        {folders.error ? (
          // A failed call used to render as "no folders found — create one on
          // x.com", which sends the reader to fix something that isn't broken.
          <>
            couldn’t load folders — {folders.error.message} ·{" "}
            <button className="notice-btn" onClick={() => void folders.refetch()}>
              retry
            </button>
          </>
        ) : !folderList ? (
          "loading folders…"
        ) : (
          <>
            sync from{" "}
            <select
              aria-label="Bookmark folder to sync"
              disabled={busy}
              defaultValue={settings.bookmarkFolderId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                const name = folderList.folders.find((f) => f.id === id)?.name ?? "";
                onRequestChange(id, name);
                setPicking(false);
              }}
            >
              <option value="">— none —</option>
              {folderList.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>{" "}
            {folderList.folders.length === 0 && <>· no bookmark folders found on x.com</>}
          </>
        )}
        {costNote && (
          <span className="new-badge" role="status">
            {" "}
            · {costNote}
          </span>
        )}{" "}
        ·{" "}
        <button className="notice-btn" onClick={() => setPicking(false)}>
          cancel
        </button>
      </p>
    );
  }

  return (
    <p className="notice">
      {settings.bookmarkFolderId ? (
        <>
          syncing from{" "}
          <button
            id={BOOKMARK_FOLDER_CONTROL_ID}
            className="notice-btn"
            onClick={() => setPicking(true)}
            disabled={busy}
          >
            {settings.bookmarkFolderName || "a folder"} ▾
          </button>{" "}
          ·{" "}
          <button className="notice-btn" onClick={onSync} disabled={busy}>
            {syncing ? "syncing…" : "sync now"}
          </button>{" "}
          ·{" "}
          <button
            className="notice-btn"
            type="button"
            onClick={() => onRequestChange(null, "")}
            disabled={busy}
          >
            stop syncing
          </button>
        </>
      ) : (
        <button
          id={BOOKMARK_FOLDER_CONTROL_ID}
          className="notice-btn"
          onClick={() => setPicking(true)}
          disabled={busy}
        >
          choose a bookmark folder to sync ▾
        </button>
      )}
      {syncNote && (
        <span className="new-badge" role="status">
          {" "}
          · {syncNote}
        </span>
      )}
      {costNote && (
        <span className="new-badge" role="status">
          {" "}
          · {costNote}
        </span>
      )}
    </p>
  );
}

/** What a finished sync is worth saying out loud. */
function describeSync(result: SyncResponse): string {
  const parts = [];
  if (result.added > 0) parts.push(`+${result.added} new`);
  if (result.removed > 0) parts.push(`−${result.removed} un-bookmarked`);
  // Still bookmarked on X, but the post can't be fetched (deleted, or the
  // author went private) — without this the bookmark just never shows up.
  if (result.unavailable > 0) parts.push(`${result.unavailable} unavailable`);
  // An unfinished scan can't tell "un-bookmarked" from "past the page
  // cap", so the server skips removals — say so instead of "up to date".
  if (!result.complete) parts.push("partial scan — removals skipped");
  // Syncing a folder reads every post in it, and a large one is dollars:
  // the note is the only place that spend is ever visible.
  if (result.cost.billable > 0) parts.push(`cost ${formatUsd(result.cost.usd, false)}`);
  return parts.length > 0 ? parts.join(" · ") : "up to date";
}

/** A validated OAuth receipt is useful on success and on rejected reconnects. */
function authCostSuffix(notice: AuthReturnNotice): string {
  return notice.cost && notice.cost.billable > 0
    ? ` · identity check cost ${formatUsd(notice.cost.usd, false)}`
    : "";
}

const TAB_KEY = "inboxTab";
const TAB_GENERATION_KEY = "inboxTabAccountGeneration";
const SAVED_TAB_ID = "inbox-tab-saved";
const SAVED_PANEL_ID = "inbox-panel-saved";
const YOURS_TAB_ID = "inbox-tab-yours";
const YOURS_PANEL_ID = "inbox-panel-yours";
const AUTH_NOTICE_PARAMS = [
  "authNotice",
  "authCostPosts",
  "authCostBillable",
  "authCostUsd",
] as const;

export function Inbox({ onOpenPost }: { onOpenPost: (postId: string) => void }) {
  const queryClient = useQueryClient();
  // Remembered across reloads and across trips into a conversation.
  const [storedTab, setStoredTab] = useState<AccountTabState>(() => ({
    tab: localStorage.getItem(TAB_KEY) === "yours" ? "yours" : "saved",
    accountGeneration: localStorage.getItem(TAB_GENERATION_KEY),
  }));
  const setTab = (next: InboxTab) => {
    setStoredTab({ tab: next, accountGeneration });
    localStorage.setItem(TAB_KEY, next);
    if (accountGeneration) localStorage.setItem(TAB_GENERATION_KEY, accountGeneration);
  };
  const [syncNote, setSyncNote] = useState<string | null>(null);
  /** Failures from the writes; the reads carry their own errors. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [lifecyclePrompt, setLifecyclePrompt] = useState<LifecyclePrompt | null>(null);
  const [returnNotice] = useState<AuthReturnNotice | null>(() => authReturnNotice(location.search));
  const [lifecycleFlight] = useState(createSingleFlight);

  const authQuery = useAuthStatus();
  const auth = authQuery.data;
  // Cached auth is deliberately not enough while its free verification is in
  // flight or after it fails: another browser tab may have installed a
  // different account.
  const accountGeneration = verifiedAccountGeneration(
    auth,
    authQuery.isFetching,
    authQuery.isError,
  );
  const accountTab = reconcileAccountTab(storedTab, accountGeneration);
  if (accountTab !== storedTab) setStoredTab(accountTab);
  const tab = accountTab.tab;
  useEffect(() => {
    localStorage.setItem(TAB_KEY, accountTab.tab);
    if (accountTab.accountGeneration) {
      localStorage.setItem(TAB_GENERATION_KEY, accountTab.accountGeneration);
    }
  }, [accountTab]);
  const authorized = auth?.state === "authorized" && accountGeneration !== null;
  // The WeakMap is the durable value; this counter only asks React to render
  // after a click updates it. Reading by generation synchronously means an
  // account transition can never render the old account's paid scan target.
  const [, setScanRevision] = useState(0);
  const scan = accountGeneration
    ? initialOwnPostsScan(queryClient, accountGeneration)
    : DEFAULT_OWN_POSTS_SCAN;
  const setScan = (next: OwnPostsScan) => {
    if (accountGeneration) rememberOwnPostsScan(queryClient, accountGeneration, next);
    setScanRevision((revision) => revision + 1);
  };

  // Callback notices are one-shot. Keep the parsed value for this mount, then
  // clean credentials/cost metadata out of copied URLs and browser history.
  useEffect(() => {
    if (!returnNotice) return;
    const clean = new URL(location.href);
    for (const key of AUTH_NOTICE_PARAMS) clean.searchParams.delete(key);
    history.replaceState(history.state, "", `${clean.pathname}${clean.search}${clean.hash}`);
  }, [returnNotice]);

  const saved = useSaved();
  const settings = useSettings(accountGeneration);
  const settingsState = folderSettingsState(settings.data, settings.error);
  const own = useOwnPosts(accountGeneration, scan, tab === "yours" && authorized);
  const savedList = saved.data;
  const ownList = own.data;
  const ownContinuation = ownList
    ? ownPostsContinuation(ownList.hasMore, ownList.items.length, scan.threads)
    : null;

  const sync = useSyncBookmarks(accountGeneration);
  const switchFolder = useSwitchBookmarkFolder();
  const clearFolder = useClearBookmarkFolder();
  const disconnect = useDisconnectX();
  const removeSaved = useRemoveSaved();
  const lifecycleBusy = sync.isPending || switchFolder.isPending || clearFolder.isPending || disconnect.isPending;

  /** Execute a sync for the caller that already owns `lifecycleFlight`. */
  const syncBookmarksOwned = async () => {
    setSyncNote(null);
    setActionError(null);
    const result = await sync.mutateAsync(undefined);
    setSyncNote(describeSync(result));
  };

  const runSync = async () => {
    try {
      await lifecycleFlight.run(syncBookmarksOwned);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  /** Selection is inert: it opens a dialog and performs no write or paid scan. */
  const requestFolderChange = (id: string | null, name: string) => {
    if (
      accountGeneration === null ||
      settingsState.kind === "loading" ||
      settingsState.kind === "error"
    ) {
      return;
    }
    const prompt = folderSelectionPrompt(
      settingsState.settings,
      id,
      name,
      accountGeneration,
    );
    if (prompt) setLifecyclePrompt(prompt);
  };

  const confirmFolderSwitch = async (prompt: SwitchFolderPrompt) => {
    setLifecyclePrompt(null);
    try {
      await lifecycleFlight.run(async () => {
        setActionError(null);
        setSyncNote(null);
        const result = await switchFolder.mutateAsync({
          id: prompt.toId,
          name: prompt.toName,
          accountGeneration: prompt.accountGeneration,
        });
        setSyncNote(describeSync(result));
      });
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const confirmDisposition = async (disposition: BookmarkDisposition) => {
    const prompt = lifecyclePrompt;
    if (!prompt || (prompt.kind !== "clear-folder" && prompt.kind !== "disconnect")) return;
    setLifecyclePrompt(null);
    try {
      await lifecycleFlight.run(async () => {
        setActionError(null);
        setSyncNote(null);
        if (prompt.kind === "clear-folder") {
          await clearFolder.mutateAsync({
            disposition,
            accountGeneration: prompt.accountGeneration,
          });
          setSyncNote(
            disposition === "keep"
              ? "sync stopped · synced items are now local saves"
              : "sync stopped · synced items removed from this app",
          );
          return;
        }
        await disconnect.mutateAsync({
          disposition,
          accountGeneration: prompt.accountGeneration,
        });
        setTab("saved");
        setScan(DEFAULT_OWN_POSTS_SCAN);
      });
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  /** Prevent a remembered Your-posts tab from buying a scan on the OAuth return. */
  const prepareOAuthNavigation = () => {
    localStorage.setItem(TAB_KEY, "saved");
    if (accountGeneration) localStorage.setItem(TAB_GENERATION_KEY, accountGeneration);
  };

  const requestReconnect = () => {
    if (accountGeneration === null) return;
    setLifecyclePrompt({
      kind: "reconnect",
      accountGeneration,
      accountLabel: connectedAccountLabel(auth),
    });
  };

  const requestDisconnect = () => {
    if (accountGeneration === null) return;
    setLifecyclePrompt({
      kind: "disconnect",
      accountGeneration,
      accountLabel: connectedAccountLabel(auth),
    });
  };

  const confirmReconnect = () => {
    const prompt = lifecyclePrompt;
    setLifecyclePrompt(null);
    if (
      !prompt ||
      prompt.kind !== "reconnect" ||
      accountGeneration !== prompt.accountGeneration
    ) {
      setActionError("X account changed; reconnect was not started");
      return;
    }
    prepareOAuthNavigation();
    location.assign(authLoginUrl(prompt.accountGeneration));
  };

  const drop = (postId: string) => {
    setActionError(null);
    removeSaved.mutate(postId, { onError: (e) => setActionError(e.message) });
  };

  // A failed scan now stays failed until someone clicks "refresh" (see
  // `useOwnPosts`), so its message has to appear where that button is: on the
  // saved tab it would be an error about another tab with no way to retry it.
  const ownError = tab === "yours" ? own.error?.message : undefined;
  const errorMessage = actionError ?? saved.error?.message ?? ownError ?? null;
  const returnAccountLabel = connectedAccountLabel(auth);

  return (
    <div>
      {lifecyclePrompt && (
        <LifecycleDialog
          prompt={lifecyclePrompt}
          onCancel={() => setLifecyclePrompt(null)}
          onSwitchFolder={(prompt) => void confirmFolderSwitch(prompt)}
          onDisposition={(disposition) => void confirmDisposition(disposition)}
          onReconnect={confirmReconnect}
        />
      )}
      <div className="tabs" role="tablist" aria-label="Inbox views">
        <button
          type="button"
          id={SAVED_TAB_ID}
          className={tab === "saved" ? "tab active" : "tab"}
          role="tab"
          aria-selected={tab === "saved"}
          aria-controls={SAVED_PANEL_ID}
          onClick={() => setTab("saved")}
        >
          Saved{savedList ? ` (${savedList.items.length})` : ""}
        </button>
        <button
          type="button"
          id={YOURS_TAB_ID}
          className={tab === "yours" ? "tab active" : "tab"}
          role="tab"
          aria-selected={tab === "yours"}
          aria-controls={YOURS_PANEL_ID}
          onClick={() => setTab("yours")}
        >
          Your posts
        </button>
      </div>

      {errorMessage && (
        <div className="error" role="alert">
          {errorMessage}
        </div>
      )}
      {returnNotice?.kind === "different-account" && (
        <p className="notice" role="alert">
          That was a different X account. x-threaded is still connected to {returnAccountLabel};
          disconnect first to use another account{authCostSuffix(returnNotice)}.
        </p>
      )}
      {returnNotice?.kind === "account-state-changed" && (
        <p className="notice" role="alert">
          The X account state changed before connecting could start. Reload and try again.
        </p>
      )}
      {returnNotice?.kind === "disconnect-first" && (
        <p className="notice" role="alert">
          x-threaded could not verify which account the broken connection belongs to, so
          reconnecting was not started. Disconnect X first, then connect the account you want.
        </p>
      )}
      {returnNotice?.kind === "different-account-revoke-failed" && (
        <p className="notice" role="alert">
          That was a different X account. x-threaded is still connected to {returnAccountLabel},
          but it could not revoke the rejected account’s new access grant. Remove x-threaded from
          that account in X Connected Apps{authCostSuffix(returnNotice)}.
        </p>
      )}
      {returnNotice?.kind === "reauthorization-conflict" && (
        <p className="notice" role="alert">
          The X connection changed while reconnecting. {returnAccountLabel} remains connected;
          retry when you’re ready{authCostSuffix(returnNotice)}.
        </p>
      )}
      {returnNotice?.kind === "reauthorized" && (
        <p className="notice" role="status">
          Reconnected {returnAccountLabel}{authCostSuffix(returnNotice)}.
        </p>
      )}
      {authQuery.error ? (
        // Not knowing is a state of its own: without this the tab simply went
        // blank, and the reader had no idea anything had failed. The wording
        // avoids repeating the message, which often already says "auth status
        // unavailable (500)".
        <p className="notice" role="alert">
          couldn’t check your X connection — {authQuery.error.message}
        </p>
      ) : (
        <ConnectPrompt
          auth={auth}
          busy={lifecycleBusy || authQuery.isFetching}
          onConnect={prepareOAuthNavigation}
          onReconnect={requestReconnect}
          onDisconnect={requestDisconnect}
        />
      )}

      <div
        id={SAVED_PANEL_ID}
        role="tabpanel"
        aria-labelledby={SAVED_TAB_ID}
        hidden={tab !== "saved"}
      >
        {tab === "saved" && (
          <>
            {authorized && (
              <FolderBar
                accountGeneration={accountGeneration}
                settingsState={settingsState}
                onRetrySettings={() => void settings.refetch()}
                onRequestChange={requestFolderChange}
                onSync={runSync}
                busy={lifecycleBusy}
                syncing={sync.isPending || switchFolder.isPending}
                syncNote={syncNote}
              />
            )}
            <ul className="conversations">
              {savedList?.items.map((item) => (
                <li
                  key={item.post.id}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    onOpenPost(item.post.id);
                  }}
                >
                  <PostView post={item.post} quoted={savedList.quoted} />
                  <div className="post-meta inbox-meta">
                    <FetchCost loaded={item.loaded} replyCount={item.post.metrics.replies} />
                    {item.source === "bookmark" ? "bookmarked" : "added here"} ·{" "}
                    {item.source === "bookmark" ? (
                      // The folder is the source of truth: removing it here
                      // would just come back on the next sync.
                      <a
                        href={xPostUrl(item.post.authorHandle, item.post.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Un-bookmark on x.com to remove it from this list"
                      >
                        un-bookmark on x.com ↗
                      </a>
                    ) : (
                      <button className="notice-btn" onClick={() => drop(item.post.id)}>
                        remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {savedList?.items.length === 0 && (
              <p className="notice">
                nothing saved yet — bookmark posts into your folder on x.com, or paste a URL above
              </p>
            )}
          </>
        )}
      </div>

      <div
        id={YOURS_PANEL_ID}
        role="tabpanel"
        aria-labelledby={YOURS_TAB_ID}
        hidden={tab !== "yours"}
      >
        {tab === "yours" && auth?.state === "authorized" && (
          <>
            <p className="notice">
              <span role="status">
                {auth.user ? `@${auth.user.username} · ` : ""}
                your recent threads{ownList ? ` (${ownList.items.length})` : ""}
              </span>{" "}
              ·{" "}
              <button
                className="notice-btn"
                onClick={() => setScan({ threads: 10, attempt: scan.attempt + 1 })}
                disabled={own.isFetching}
              >
                {own.isFetching ? "loading…" : "refresh"}
              </button>
              {/* Scanning the timeline is an Owned Read per post, so asking for
                  more threads is a purchase, not a page turn. */}
              {ownList && ownList.cost.billable > 0 && (
                <span role="status"> · scan {formatUsd(ownList.cost.usd, false)}</span>
              )}
            </p>
            <ul className="conversations">
              {ownList?.items.map((item) => (
                <li
                  key={item.root.id}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    onOpenPost(item.root.id);
                  }}
                >
                  <PostView post={item.root} quoted={ownList.quoted} />
                  <div className="post-meta inbox-meta">
                    <FetchCost loaded={item.loaded} replyCount={item.root.metrics.replies} />
                    {item.ownPostCount > 1 && <>thread of {item.ownPostCount} · </>}
                    {item.root.metrics.replies}{" "}
                    {item.root.metrics.replies === 1 ? "reply" : "replies"}
                  </div>
                </li>
              ))}
            </ul>
            {ownList?.items.length === 0 && <p className="notice">no recent posts found</p>}
            {ownContinuation === "load-more" && (
              <p className="notice">
                <button
                  className="notice-btn"
                  onClick={() => setScan({ ...scan, threads: scan.threads + 10 })}
                  disabled={own.isFetching}
                >
                  {own.isFetching ? "loading…" : "load 10 more"}
                </button>
              </p>
            )}
            {ownContinuation === "limit-reached" && (
              <p className="notice" role="status">
                more posts may exist, but this scan reached its safe per-request limit
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

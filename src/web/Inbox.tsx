import { useState } from "react";
import type { AuthStatus, SyncResponse } from "../shared/types";
import {
  useAuthStatus,
  useFolders,
  useOwnPosts,
  useRemoveSaved,
  useSaved,
  useSetBookmarkFolder,
  useSettings,
  useSyncBookmarks,
  type OwnPostsScan,
} from "./queries";
import { PostView } from "./PostView";
import { estimateFetchUsd, formatUsd } from "../shared/pricing";
import { xPostUrl } from "../shared/urls";
import {
  createSingleFlight,
  folderCostNotice,
  folderSettingsState,
  type FolderSettingsState,
} from "./inbox-state";

type Tab = "saved" | "yours";

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

/** Prompt to authorize X, shown wherever user-context features are needed. */
function ConnectPrompt({ auth }: { auth: AuthStatus | undefined }) {
  // Undefined means we don't know yet, or couldn't find out. Either way this
  // says nothing: claiming "no OAuth credentials" on a failed status call
  // would be an accusation against the deployment, not a fact.
  if (!auth || auth.state === "authorized") return null;
  if (auth.state === "unconfigured") {
    return (
      <p className="notice" role="status">
        user-context features are off — this deployment has no OAuth credentials (see
        .env.example)
      </p>
    );
  }
  return (
    <p className="notice" role="status">
      <a className="connect-link" href={auth.loginUrl}>
        Connect your X account
      </a>{" "}
      to sync bookmarks and see your posts
      {auth.state === "broken" && (
        // The grant is gone; reconnecting is the only fix, so say so plainly
        // and keep the machine-readable reason for a hover.
        <span className="new-badge" title={auth.reason}>
          {" "}
          · X session lost — reconnect
        </span>
      )}
    </p>
  );
}

/** Folder picker plus sync control for the saved tab. */
function FolderBar({
  settingsState,
  onRetrySettings,
  onChange,
  onSync,
  settingFolder,
  syncing,
  syncNote,
}: {
  settingsState: FolderSettingsState;
  onRetrySettings: () => void;
  onChange: (id: string | null, name: string) => void;
  onSync: () => void;
  settingFolder: boolean;
  syncing: boolean;
  syncNote: string | null;
}) {
  const [picking, setPicking] = useState(false);
  const folders = useFolders(picking);
  const folderList = folders.data;
  const costNote = folderCostNotice(folderList);
  const folderBusy = settingFolder || syncing;

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
        ) : folderList.folders.length === 0 ? (
          <>no bookmark folders found — create one on x.com, then reopen this picker</>
        ) : (
          <>
            sync from{" "}
            <select
              aria-label="Bookmark folder to sync"
              disabled={folderBusy}
              defaultValue={settings.bookmarkFolderId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                const name = folderList.folders.find((f) => f.id === id)?.name ?? "";
                onChange(id, name);
                setPicking(false);
              }}
            >
              <option value="">— none —</option>
              {folderList.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
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
            className="notice-btn"
            onClick={() => setPicking(true)}
            disabled={folderBusy}
          >
            {settings.bookmarkFolderName || "a folder"} ▾
          </button>{" "}
          ·{" "}
          <button className="notice-btn" onClick={onSync} disabled={folderBusy}>
            {syncing ? "syncing…" : "sync now"}
          </button>
        </>
      ) : (
        <button
          className="notice-btn"
          onClick={() => setPicking(true)}
          disabled={folderBusy}
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

const TAB_KEY = "inboxTab";
const SAVED_TAB_ID = "inbox-tab-saved";
const SAVED_PANEL_ID = "inbox-panel-saved";
const YOURS_TAB_ID = "inbox-tab-yours";
const YOURS_PANEL_ID = "inbox-panel-yours";

/**
 * The scan the Your-posts tab is on, kept outside the component because the
 * inbox unmounts every time a conversation is opened.
 *
 * As component state it rewound to attempt 0 on the way back, so the tab
 * showed the first scan again and the next "refresh" click asked for a key the
 * cache already held — answering a request to go and buy a new scan out of the
 * old one. A page reload does reset it, deliberately: the QueryClient is new
 * then too, so attempt 0 is genuinely unbought.
 */
let lastScan: OwnPostsScan = { threads: 10, attempt: 0 };

export function Inbox({ onOpenPost }: { onOpenPost: (postId: string) => void }) {
  // Remembered across reloads and across trips into a conversation.
  const [tab, setTabState] = useState<Tab>(() =>
    localStorage.getItem(TAB_KEY) === "yours" ? "yours" : "saved",
  );
  const setTab = (next: Tab) => {
    setTabState(next);
    localStorage.setItem(TAB_KEY, next);
  };
  /** Bumping this is how the tab buys a timeline scan; see `useOwnPosts`. */
  const [scan, setScanState] = useState<OwnPostsScan>(() => lastScan);
  const setScan = (next: OwnPostsScan) => {
    lastScan = next;
    setScanState(next);
  };
  const [syncNote, setSyncNote] = useState<string | null>(null);
  /** Failures from the writes; the reads carry their own errors. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncFlight] = useState(createSingleFlight);

  const saved = useSaved();
  const settings = useSettings();
  const settingsState = folderSettingsState(settings.data, settings.error);
  const authQuery = useAuthStatus();
  const auth = authQuery.data;
  const authorized = auth?.state === "authorized";
  const own = useOwnPosts(scan, tab === "yours" && authorized);
  const savedList = saved.data;
  const ownList = own.data;

  const sync = useSyncBookmarks();
  const setFolder = useSetBookmarkFolder();
  const removeSaved = useRemoveSaved();

  /** Execute a sync for the caller that already owns `syncFlight`. */
  const syncBookmarksOwned = async () => {
    setSyncNote(null);
    setActionError(null);
    const result = await sync.mutateAsync(undefined);
    setSyncNote(describeSync(result));
  };

  const runSync = async () => {
    try {
      await syncFlight.run(syncBookmarksOwned);
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  const changeFolder = async (id: string | null, name: string) => {
    try {
      await syncFlight.run(async () => {
        setActionError(null);
        await setFolder.mutateAsync({ id, name });
        // Picking a folder is only half the instruction; the list is empty
        // until it has been scanned. Keep the same ownership through the sync.
        if (id) await syncBookmarksOwned();
      });
    } catch (e) {
      setActionError((e as Error).message);
    }
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

  return (
    <div>
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
      {authQuery.error ? (
        // Not knowing is a state of its own: without this the tab simply went
        // blank, and the reader had no idea anything had failed. The wording
        // avoids repeating the message, which often already says "auth status
        // unavailable (500)".
        <p className="notice" role="alert">
          couldn’t check your X connection — {authQuery.error.message}
        </p>
      ) : (
        <ConnectPrompt auth={auth} />
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
                settingsState={settingsState}
                onRetrySettings={() => void settings.refetch()}
                onChange={changeFolder}
                onSync={runSync}
                settingFolder={setFolder.isPending}
                syncing={sync.isPending}
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
            {ownList?.hasMore && (
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
          </>
        )}
      </div>
    </div>
  );
}

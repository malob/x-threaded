import { useState } from "react";
import type { AuthStatus, SettingsResponse, SyncResponse } from "../shared/types";
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

type Tab = "saved" | "yours";

/**
 * Whether opening this card costs anything, shown so clicking is informed
 * consent — inbox clicks fetch straight away rather than prompting.
 *
 * A loaded conversation is cheap, not free: opening one on a new UTC day
 * refreshes it, and that read bills. So the tag says what we know — the
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
      <p className="notice">
        user-context features are off — this deployment has no OAuth credentials (see
        .env.example)
      </p>
    );
  }
  return (
    <p className="notice">
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
  settings,
  onChange,
  onSync,
  syncing,
  syncNote,
}: {
  settings: SettingsResponse | undefined;
  onChange: (id: string | null, name: string) => void;
  onSync: () => void;
  syncing: boolean;
  syncNote: string | null;
}) {
  const [picking, setPicking] = useState(false);
  const folders = useFolders(picking);
  const folderList = folders.data;

  if (picking) {
    return (
      <p className="notice">
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
              defaultValue={settings?.bookmarkFolderId ?? ""}
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
      {settings?.bookmarkFolderId ? (
        <>
          syncing from{" "}
          <button className="notice-btn" onClick={() => setPicking(true)}>
            {settings.bookmarkFolderName || "a folder"} ▾
          </button>{" "}
          ·{" "}
          <button className="notice-btn" onClick={onSync} disabled={syncing}>
            {syncing ? "syncing…" : "sync now"}
          </button>
        </>
      ) : (
        <button className="notice-btn" onClick={() => setPicking(true)}>
          choose a bookmark folder to sync ▾
        </button>
      )}
      {syncNote && <span className="new-badge"> · {syncNote}</span>}
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
  const [scan, setScan] = useState<OwnPostsScan>({ threads: 10, attempt: 0 });
  const [syncNote, setSyncNote] = useState<string | null>(null);
  /** Failures from the writes; the reads carry their own errors. */
  const [actionError, setActionError] = useState<string | null>(null);

  const saved = useSaved();
  const settings = useSettings();
  const authQuery = useAuthStatus();
  const auth = authQuery.data;
  const authorized = auth?.state === "authorized";
  const own = useOwnPosts(scan, tab === "yours" && authorized);
  const savedList = saved.data;
  const ownList = own.data;

  const sync = useSyncBookmarks();
  const setFolder = useSetBookmarkFolder();
  const removeSaved = useRemoveSaved();

  const runSync = () => {
    setSyncNote(null);
    setActionError(null);
    sync.mutate(undefined, {
      onSuccess: (result) => setSyncNote(describeSync(result)),
      onError: (e) => setActionError(e.message),
    });
  };

  const changeFolder = (id: string | null, name: string) => {
    setActionError(null);
    setFolder.mutate(
      { id, name },
      {
        // Picking a folder is only half the instruction; the list is empty
        // until it has been scanned.
        onSuccess: () => {
          if (id) runSync();
        },
        onError: (e) => setActionError(e.message),
      },
    );
  };

  const drop = (postId: string) => {
    setActionError(null);
    removeSaved.mutate(postId, { onError: (e) => setActionError(e.message) });
  };

  const errorMessage = actionError ?? saved.error?.message ?? own.error?.message ?? null;

  return (
    <div>
      <div className="tabs">
        <button className={tab === "saved" ? "tab active" : "tab"} onClick={() => setTab("saved")}>
          Saved{savedList ? ` (${savedList.items.length})` : ""}
        </button>
        <button className={tab === "yours" ? "tab active" : "tab"} onClick={() => setTab("yours")}>
          Your posts
        </button>
      </div>

      {errorMessage && <div className="error">{errorMessage}</div>}
      {authQuery.error ? (
        // Not knowing is a state of its own: without this the tab simply went
        // blank, and the reader had no idea anything had failed. The wording
        // avoids repeating the message, which often already says "auth status
        // unavailable (500)".
        <p className="notice">couldn’t check your X connection — {authQuery.error.message}</p>
      ) : (
        <ConnectPrompt auth={auth} />
      )}

      {tab === "saved" ? (
        <>
          {authorized && (
            <FolderBar
              settings={settings.data}
              onChange={changeFolder}
              onSync={runSync}
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
      ) : auth?.state !== "authorized" ? null : (
        <>
          <p className="notice">
            {auth.user ? `@${auth.user.username} · ` : ""}
            your recent threads{ownList ? ` (${ownList.items.length})` : ""} ·{" "}
            <button
              className="notice-btn"
              onClick={() => setScan((previous) => ({ threads: 10, attempt: previous.attempt + 1 }))}
              disabled={own.isFetching}
            >
              {own.isFetching ? "loading…" : "refresh"}
            </button>
            {/* Scanning the timeline is an Owned Read per post, so asking for
                more threads is a purchase, not a page turn. */}
            {ownList && ownList.cost.billable > 0 && (
              <> · scan {formatUsd(ownList.cost.usd, false)}</>
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
                onClick={() =>
                  setScan((previous) => ({ ...previous, threads: previous.threads + 10 }))
                }
                disabled={own.isFetching}
              >
                {own.isFetching ? "loading…" : "load 10 more"}
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}

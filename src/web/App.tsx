import { useEffect, useState } from "react";
import type { ConversationResponse } from "../shared/types";
import {
  getConversation,
  loadConversation,
  markConversationRead,
  refreshConversation,
  resolvePost,
  resumeConversation,
  setReadState,
} from "./api";
import { Inbox } from "./Inbox";
import { Thread } from "./Thread";
import { estimateFetchUsd, formatUsd } from "../shared/pricing";
import { appPath, parsePostPath, xPostUrl } from "../shared/urls";

export function App() {
  const [url, setUrl] = useState("");
  const [current, setCurrent] = useState<ConversationResponse | null>(null);
  /** Post ID from a deep link whose conversation isn't cached; awaiting consent to fetch. */
  const [pending, setPending] = useState<string | null>(null);
  /** Estimated cost of fetching `pending`, when the post itself is cached. */
  const [pendingCost, setPendingCost] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [newCount, setNewCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The inbox reloads itself whenever it mounts, so leaving a conversation is
  // enough to pick up new read state — no cross-component refresh plumbing.
  const autoRefresh = async (rootId: string) => {
    setRefreshing(true);
    try {
      const fresh = await refreshConversation(rootId);
      // Keep the deep-link focus; the refresh response doesn't know about it.
      setCurrent((prev) => ({ ...fresh, focusId: prev?.focusId ?? null }));
      setNewCount(fresh.newCount);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Buy the history a stopped fetch never reached. Deliberately manual: the
   * conversation reads fine without it, and going back for the older replies
   * costs money, so it happens when someone asks for it.
   */
  const resumeOlder = async (rootId: string) => {
    setResuming(true);
    try {
      const older = await resumeConversation(rootId);
      setCurrent((prev) => ({ ...older, focusId: prev?.focusId ?? null }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResuming(false);
    }
  };

  /**
   * Open the conversation containing a post, focused on it.
   *
   * When it isn't cached, a deep link stops and asks first — the visitor has
   * seen no price. Inbox cards pass `fetchIfMissing` because they display
   * the estimated cost, so the click is already informed consent.
   */
  const openPost = async (postId: string, push = true, fetchIfMissing = false) => {
    setError(null);
    setNewCount(null);
    setPending(null);
    try {
      const { rootId, replyCount } = await resolvePost(postId);
      if (!rootId) {
        if (fetchIfMissing) {
          await fetchConversation(postId, push);
          return;
        }
        setCurrent(null);
        setPending(postId);
        setPendingCost(replyCount === null ? null : estimateFetchUsd(replyCount));
        // Route to the post anyway, so reloading returns to this prompt
        // rather than the inbox. The handle is unknown until it's fetched;
        // "i" is the same placeholder x.com uses.
        if (push) history.pushState({}, "", appPath(undefined, postId));
        return;
      }
      const cached = await getConversation(rootId);
      const focusId = postId === rootId ? null : postId;
      setCurrent({ ...cached, focusId });
      if (push) {
        const post = cached.posts.find((p) => p.id === postId);
        history.pushState({}, "", appPath(post?.authorHandle, postId));
      }
      void autoRefresh(rootId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Fetch a conversation from the API and show it. */
  const fetchConversation = async (postId: string, push = true) => {
    setLoading(true);
    setError(null);
    try {
      const response = await loadConversation(postId);
      setCurrent(response);
      setPending(null);
      const shownId = response.focusId ?? response.rootId;
      const post = response.posts.find((p) => p.id === shownId);
      const path = appPath(post?.authorHandle, shownId);
      if (push) history.pushState({}, "", path);
      else history.replaceState({}, "", path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const fetchPending = async () => {
    if (pending) await fetchConversation(pending, false);
  };

  const goHome = (push = true) => {
    setCurrent(null);
    setNewCount(null);
    setPending(null);
    if (push) history.pushState({}, "", "/");
  };

  useEffect(() => {
    const applyLocation = () => {
      const postId = parsePostPath(location.pathname);
      if (postId) void openPost(postId, false);
      else goHome(false);
    };
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!current) {
      document.title = "x-threaded";
      return;
    }
    const root = current.posts.find((p) => p.id === current.rootId);
    const snippet = root ? `@${root.authorHandle}: ${root.text.slice(0, 60)}` : current.rootId;
    document.title = `${snippet} — x-threaded`;
  }, [current]);

  const submitUrl = async () => {
    setLoading(true);
    setError(null);
    setNewCount(null);
    try {
      const response = await loadConversation(url);
      setCurrent(response);
      setPending(null);
      const shownId = response.focusId ?? response.rootId;
      const post = response.posts.find((p) => p.id === shownId);
      history.pushState({}, "", appPath(post?.authorHandle, shownId));
      if (response.fromCache) void autoRefresh(response.rootId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const setRead = (ids: string[], read: boolean) => {
    setCurrent((prev) => {
      if (!prev) return prev;
      setReadState(ids, read).catch((e: Error) => setError(e.message));
      const unread = new Set(prev.unreadIds);
      for (const id of ids) {
        if (read) unread.delete(id);
        else unread.add(id);
      }
      return { ...prev, unreadIds: [...unread] };
    });
  };

  const markAllRead = () => {
    setCurrent((prev) => {
      if (!prev) return prev;
      markConversationRead(prev.rootId).catch((e: Error) => setError(e.message));
      return { ...prev, unreadIds: [] };
    });
  };

  return (
    <main>
      <form
        className="lookup"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void submitUrl();
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste an x.com post URL"
        />
        <button type="submit" disabled={loading}>
          {loading ? "Loading…" : "Load"}
        </button>
        {(current || pending) && (
          <button type="button" onClick={() => goHome()}>
            Back
          </button>
        )}
      </form>

      {error && <div className="error">{error}</div>}

      {pending ? (
        <div className="load-prompt">
          <p>This conversation isn’t loaded yet.</p>
          <p>
            <button onClick={() => void fetchPending()} disabled={loading}>
              {loading ? "Fetching…" : "Fetch conversation"}
            </button>
            {pendingCost !== null && (
              <span className="post-meta"> {formatUsd(pendingCost)}</span>
            )}
            {"  "}
            <a href={xPostUrl(undefined, pending)} target="_blank" rel="noopener noreferrer">
              view on x.com ↗
            </a>
          </p>
        </div>
      ) : current ? (
        <Thread
          conversation={current}
          refreshing={refreshing}
          resuming={resuming}
          newCount={newCount}
          onRefresh={() => void autoRefresh(current.rootId)}
          onResume={() => void resumeOlder(current.rootId)}
          onSetRead={setRead}
          onMarkAllRead={markAllRead}
        />
      ) : (
        <Inbox onOpenPost={(postId) => void openPost(postId, true, true)} />
      )}
    </main>
  );
}

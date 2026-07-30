import { useEffect, useState } from "react";
import type { ConversationListResponse, ConversationResponse } from "../shared/types";
import {
  getConversation,
  listConversations,
  loadConversation,
  markConversationRead,
  refreshConversation,
  resolvePost,
  setReadState,
} from "./api";
import { PostView } from "./PostView";
import { Thread } from "./Thread";

/**
 * Routes mirror x.com so a post URL becomes an app URL by swapping the
 * domain: /<handle>/status/<postId>. The handle is decorative (as on X);
 * the post ID identifies both the conversation and the focus post.
 */
function parseRoute(pathname: string): { postId: string } | null {
  const match = pathname.match(/^\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/(\d+)/);
  return match ? { postId: match[1]! } : null;
}

function postPath(handle: string | undefined, postId: string): string {
  return `/${handle ?? "i"}/status/${postId}`;
}

export function App() {
  const [url, setUrl] = useState("");
  const [inbox, setInbox] = useState<ConversationListResponse>({ conversations: [], quoted: {} });
  const [current, setCurrent] = useState<ConversationResponse | null>(null);
  /** Post ID from a deep link whose conversation isn't cached; awaiting consent to fetch. */
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newCount, setNewCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshList = () => {
    listConversations().then(setInbox).catch((e: Error) => setError(e.message));
  };

  const autoRefresh = async (rootId: string) => {
    setRefreshing(true);
    try {
      const fresh = await refreshConversation(rootId);
      // Keep the deep-link focus; the refresh response doesn't know about it.
      setCurrent((prev) => ({ ...fresh, focusId: prev?.focusId ?? null }));
      setNewCount(fresh.newCount);
      refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Open the conversation containing a post, focused on it. When the
   * conversation isn't cached, don't fetch — set `pending` so the UI can
   * offer to (deep links must not spend API credits without a click).
   */
  const openPost = async (postId: string, push = true) => {
    setError(null);
    setNewCount(null);
    setPending(null);
    try {
      const { rootId } = await resolvePost(postId);
      if (!rootId) {
        setCurrent(null);
        setPending(postId);
        return;
      }
      const cached = await getConversation(rootId);
      const focusId = postId === rootId ? null : postId;
      setCurrent({ ...cached, focusId });
      if (push) {
        const post = cached.posts.find((p) => p.id === postId);
        history.pushState({}, "", postPath(post?.authorHandle, postId));
      }
      void autoRefresh(rootId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const fetchPending = async () => {
    if (!pending) return;
    setLoading(true);
    setError(null);
    try {
      const response = await loadConversation(pending);
      setCurrent(response);
      setPending(null);
      const shownId = response.focusId ?? response.rootId;
      const post = response.posts.find((p) => p.id === shownId);
      history.replaceState({}, "", postPath(post?.authorHandle, shownId));
      refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const goHome = (push = true) => {
    setCurrent(null);
    setNewCount(null);
    setPending(null);
    refreshList();
    if (push) history.pushState({}, "", "/");
  };

  useEffect(() => {
    const applyLocation = () => {
      const route = parseRoute(location.pathname);
      if (route) void openPost(route.postId, false);
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
      history.pushState({}, "", postPath(post?.authorHandle, shownId));
      refreshList();
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
      setReadState(ids, read).then(refreshList).catch((e: Error) => setError(e.message));
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
      markConversationRead(prev.rootId).then(refreshList).catch((e: Error) => setError(e.message));
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
            {"  "}
            <a href={`https://x.com/i/status/${pending}`} target="_blank" rel="noopener noreferrer">
              view on x.com ↗
            </a>
          </p>
        </div>
      ) : current ? (
        <Thread
          conversation={current}
          refreshing={refreshing}
          newCount={newCount}
          onRefresh={() => void autoRefresh(current.rootId)}
          onSetRead={setRead}
          onMarkAllRead={markAllRead}
        />
      ) : (
        <ul className="conversations">
          {inbox.conversations.map((c) => (
            <li
              key={c.root.id}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a, button")) return;
                void openPost(c.root.id);
              }}
            >
              <PostView post={c.root} quoted={inbox.quoted} />
              <div className="post-meta inbox-meta">
                {c.postCount - 1} {c.postCount === 2 ? "reply" : "replies"}
                {c.unreadCount > 0 && <span className="new-badge"> · {c.unreadCount} new</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

import { useEffect, useState } from "react";
import type { ConversationListResponse, ConversationResponse } from "../shared/types";
import {
  getConversation,
  listConversations,
  loadConversation,
  markConversationRead,
  refreshConversation,
  setReadState,
} from "./api";
import { PostView } from "./PostView";
import { Thread } from "./Thread";

export function App() {
  const [url, setUrl] = useState("");
  const [inbox, setInbox] = useState<ConversationListResponse>({ conversations: [], quoted: {} });
  const [current, setCurrent] = useState<ConversationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newCount, setNewCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshList = () => {
    listConversations().then(setInbox).catch((e: Error) => setError(e.message));
  };

  useEffect(refreshList, []);

  const autoRefresh = async (rootId: string) => {
    setRefreshing(true);
    try {
      const fresh = await refreshConversation(rootId);
      setCurrent(fresh);
      setNewCount(fresh.newCount);
      refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const openConversation = async (rootId: string) => {
    setError(null);
    setNewCount(null);
    try {
      setCurrent(await getConversation(rootId));
      void autoRefresh(rootId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submitUrl = async () => {
    setLoading(true);
    setError(null);
    setNewCount(null);
    try {
      const response = await loadConversation(url);
      setCurrent(response);
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
        {current && (
          <button
            type="button"
            onClick={() => {
              setCurrent(null);
              setNewCount(null);
              refreshList();
            }}
          >
            Back
          </button>
        )}
      </form>

      {error && <div className="error">{error}</div>}

      {current ? (
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
                void openConversation(c.root.id);
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

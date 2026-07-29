import { useEffect, useState } from "react";
import type { ConversationResponse, ConversationSummary } from "../shared/types";
import { getConversation, listConversations, loadConversation } from "./api";
import { Thread } from "./Thread";

export function App() {
  const [url, setUrl] = useState("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<ConversationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshList = () => {
    listConversations().then(setConversations).catch((e: Error) => setError(e.message));
  };

  useEffect(refreshList, []);

  const run = async (task: () => Promise<ConversationResponse>) => {
    setLoading(true);
    setError(null);
    try {
      setCurrent(await task());
      refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main>
      <form
        className="lookup"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void run(() => loadConversation(url));
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
          <button type="button" onClick={() => setCurrent(null)}>
            Back
          </button>
        )}
      </form>

      {error && <div className="error">{error}</div>}

      {current ? (
        <Thread conversation={current} />
      ) : (
        <ul className="conversations">
          {conversations.map((c) => (
            <li key={c.rootId} onClick={() => void run(() => getConversation(c.rootId))}>
              <div className="post-meta">
                <span className="name">@{c.rootAuthorHandle}</span> · {c.postCount} posts
              </div>
              <div className="post-text">{c.rootText.slice(0, 140)}</div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

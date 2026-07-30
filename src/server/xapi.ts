import type { MediaItem, Post, PostEntities, UrlEntity } from "../shared/types";

const API_BASE = "https://api.x.com/2";
const POST_FIELDS =
  "created_at,public_metrics,author_id,conversation_id,referenced_tweets,entities,attachments,note_tweet";
const EXPANSIONS =
  "author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys";
const USER_FIELDS = "name,username,profile_image_url";
const MEDIA_FIELDS = "type,url,preview_image_url,width,height";
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 1100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ApiTweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  conversation_id: string;
  referenced_tweets?: { type: string; id: string }[];
  entities?: { urls?: UrlEntity[] };
  attachments?: { media_keys?: string[] };
  /** Full text of long posts; the plain text field is truncated to ~280. */
  note_tweet?: { text: string; entities?: { urls?: UrlEntity[] } };
  public_metrics?: {
    like_count: number;
    reply_count: number;
    retweet_count: number;
    quote_count: number;
    bookmark_count?: number;
    impression_count: number;
  };
}

interface ApiUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
}

interface ApiMedia {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
  width?: number;
  height?: number;
}

interface Includes {
  users?: ApiUser[];
  tweets?: ApiTweet[];
  media?: ApiMedia[];
}

interface SearchPage {
  data?: ApiTweet[];
  includes?: Includes;
  meta?: { next_token?: string; result_count: number };
}

interface TweetLookup {
  data?: ApiTweet;
  includes?: Includes;
  errors?: { title?: string; detail?: string }[];
}

export class XApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

export interface FetchedConversation {
  posts: Post[];
  /** Referenced posts from includes (quoted posts, recovered parents). */
  referenced: Post[];
  truncated: boolean;
}

/** The v2 API HTML-escapes &, <, > in post text; x.com renders them unescaped. */
function unescapeText(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function toPost(
  tweet: ApiTweet,
  users: Map<string, ApiUser>,
  mediaByKey: Map<string, ApiMedia>,
  fetchedAt: string,
): Post {
  const author = users.get(tweet.author_id);
  const parent = tweet.referenced_tweets?.find((r) => r.type === "replied_to");
  const quoted = tweet.referenced_tweets?.find((r) => r.type === "quoted");
  const text = tweet.note_tweet?.text ?? tweet.text;
  const urls = tweet.note_tweet?.entities?.urls ?? tweet.entities?.urls;
  const entities: PostEntities | null = urls?.length
    ? { urls: urls.map(({ url, expanded_url, display_url }) => ({ url, expanded_url, display_url })) }
    : null;
  const media: MediaItem[] = (tweet.attachments?.media_keys ?? [])
    .map((key) => mediaByKey.get(key))
    .filter((m) => m !== undefined)
    .map((m) => ({
      mediaKey: m.media_key,
      type: m.type,
      url: m.url ?? null,
      previewImageUrl: m.preview_image_url ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
    }));
  const m = tweet.public_metrics;
  return {
    id: tweet.id,
    conversationId: tweet.conversation_id,
    parentId: parent?.id ?? null,
    authorId: tweet.author_id,
    authorHandle: author?.username ?? "unknown",
    authorName: author?.name ?? "Unknown",
    authorAvatarUrl: author?.profile_image_url ?? null,
    text: unescapeText(text),
    createdAt: tweet.created_at,
    metrics: {
      likes: m?.like_count ?? 0,
      replies: m?.reply_count ?? 0,
      reposts: m?.retweet_count ?? 0,
      quotes: m?.quote_count ?? 0,
      bookmarks: m?.bookmark_count ?? 0,
      impressions: m?.impression_count ?? 0,
    },
    entities,
    quotedPostId: quoted?.id ?? null,
    media: media.length > 0 ? media : null,
    fetchedAt,
  };
}

function mediaMap(includes: Includes | undefined): Map<string, ApiMedia> {
  return new Map((includes?.media ?? []).map((m) => [m.media_key, m]));
}

export class XApi {
  constructor(private readonly bearerToken: string) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    let response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });
    if (response.status === 429 || response.status >= 500) {
      const resetHeader = response.headers.get("x-rate-limit-reset");
      const waitMs =
        response.status === 429
          ? resetHeader
            ? Math.max(0, Number(resetHeader) * 1000 - Date.now()) + 1000
            : 5000
          : 2000;
      await sleep(Math.min(waitMs, 60_000));
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
      });
    }
    if (!response.ok) {
      const body = await response.text();
      throw new XApiError(`X API ${response.status} on ${path}: ${body}`, response.status);
    }
    return (await response.json()) as T;
  }

  /** Look up a single post ($0.005). */
  async getPost(id: string): Promise<Post> {
    const result = await this.get<TweetLookup>(`/tweets/${id}`, {
      "tweet.fields": POST_FIELDS,
      expansions: EXPANSIONS,
      "user.fields": USER_FIELDS,
      "media.fields": MEDIA_FIELDS,
    });
    if (!result.data) {
      const detail = result.errors?.[0]?.detail ?? "post not found or unavailable";
      throw new XApiError(detail, 404);
    }
    const users = new Map((result.includes?.users ?? []).map((u) => [u.id, u]));
    return toPost(result.data, users, mediaMap(result.includes), new Date().toISOString());
  }

  /** Fetch specific posts by ID (up to 100 per request), media fully resolved. */
  async getPostsByIds(ids: string[]): Promise<Post[]> {
    const results: Post[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const page = await this.get<SearchPage>("/tweets", {
        ids: ids.slice(i, i + 100).join(","),
        "tweet.fields": POST_FIELDS,
        expansions: EXPANSIONS,
        "user.fields": USER_FIELDS,
        "media.fields": MEDIA_FIELDS,
      });
      const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
      const media = mediaMap(page.includes);
      const fetchedAt = new Date().toISOString();
      for (const tweet of page.data ?? []) {
        results.push(toPost(tweet, users, media, fetchedAt));
      }
    }
    return results;
  }

  /**
   * Fetch every post in a conversation via full-archive search, paginated.
   * Stops at maxPosts and reports truncation. Billed $0.005 per post returned
   * (deduplicated within a 24h UTC window).
   */
  async fetchConversation(
    conversationId: string,
    maxPosts: number,
    sinceId?: string,
  ): Promise<FetchedConversation> {
    const fetchedAt = new Date().toISOString();
    const posts: Post[] = [];
    const referencedById = new Map<string, Post>();
    const unresolvedMedia = new Set<string>();
    let nextToken: string | undefined;
    let truncated = false;

    do {
      const params: Record<string, string> = {
        query: `conversation_id:${conversationId}`,
        max_results: String(PAGE_SIZE),
        "tweet.fields": POST_FIELDS,
        expansions: EXPANSIONS,
        "user.fields": USER_FIELDS,
        "media.fields": MEDIA_FIELDS,
      };
      if (sinceId) params.since_id = sinceId;
      if (nextToken) params.next_token = nextToken;

      const page = await this.get<SearchPage>("/tweets/search/all", params);
      const users = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
      const media = mediaMap(page.includes);
      for (const tweet of page.data ?? []) {
        posts.push(toPost(tweet, users, media, fetchedAt));
      }
      for (const tweet of page.includes?.tweets ?? []) {
        const post = toPost(tweet, users, media, fetchedAt);
        referencedById.set(post.id, post);
        if ((tweet.attachments?.media_keys?.length ?? 0) > 0 && post.media === null) {
          unresolvedMedia.add(post.id);
        }
      }

      nextToken = page.meta?.next_token;
      if (nextToken && posts.length >= maxPosts) {
        truncated = true;
        break;
      }
      if (nextToken) await sleep(PAGE_DELAY_MS);
    } while (nextToken);

    // Referenced posts arrive without their media objects (the API only ships
    // media for main results); re-look them up to resolve images.
    const postIds = new Set(posts.map((p) => p.id));
    const toRefetch = [...unresolvedMedia].filter((id) => !postIds.has(id));
    if (toRefetch.length > 0) {
      for (const post of await this.getPostsByIds(toRefetch)) {
        referencedById.set(post.id, post);
      }
    }

    return { posts, referenced: [...referencedById.values()], truncated };
  }
}

import { describe, expect, it } from "bun:test";
import ts from "typescript";

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

async function parseWebFile(name: string): Promise<ts.SourceFile> {
  const url = new URL(`../src/web/${name}`, import.meta.url);
  const source = await Bun.file(url).text();
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function openings(source: ts.SourceFile): Opening[] {
  const found: Opening[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function tag(element: Opening): string {
  return element.tagName.getText(element.getSourceFile());
}

function attribute(element: Opening, name: string): string | undefined {
  const property = element.attributes.properties.find(
    (candidate): candidate is ts.JsxAttribute =>
      ts.isJsxAttribute(candidate) && candidate.name.getText(element.getSourceFile()) === name,
  );
  if (!property) return undefined;
  return property.initializer?.getText(element.getSourceFile()) ?? "";
}

function elementWith(
  elements: readonly Opening[],
  tagName: string,
  attributeName: string,
  value: string,
): Opening {
  const element = elements.find(
    (candidate) => tag(candidate) === tagName && attribute(candidate, attributeName) === value,
  );
  if (!element) throw new Error(`${tagName}[${attributeName}=${value}] missing`);
  return element;
}

describe("nonvisual accessibility markup", () => {
  it("names the URL and bookmark-folder controls", async () => {
    const app = openings(await parseWebFile("App.tsx"));
    const inbox = openings(await parseWebFile("Inbox.tsx"));

    const urlInput = elementWith(app, "input", "placeholder", '"Paste an x.com post URL"');
    expect(attribute(urlInput, "aria-label")).toBe('"X post URL"');

    const folderSelect = elementWith(inbox, "select", "defaultValue", '{settings.bookmarkFolderId ?? ""}');
    expect(attribute(folderSelect, "aria-label")).toBe('"Bookmark folder to sync"');
  });

  it("serializes every bookmark/account lifecycle mutation after confirmation", async () => {
    const source = await parseWebFile("Inbox.tsx");
    const inbox = openings(source);
    expect(source.text).toContain("const [lifecycleFlight] = useState(createSingleFlight);");
    expect(source.text).toContain("await lifecycleFlight.run(async () =>");
    expect(source.text).toContain("await sync.mutateAsync(undefined)");
    expect(source.text).toContain("await switchFolder.mutateAsync({");
    expect(source.text).toContain("await clearFolder.mutateAsync({");
    expect(source.text).toContain("await disconnect.mutateAsync({");
    // A dialog opened under account A must keep sending A even if a focus
    // refresh changes the component's current generation to B before confirm.
    expect(source.text.match(/accountGeneration: prompt\.accountGeneration/g)).toHaveLength(3);
    expect(source.text).toContain(
      'accountGeneration: prompt.accountGeneration,\n        });\n        setTab("saved");',
    );
    expect(source.text).not.toContain("sync.mutate(undefined");
    const requestFolder = source.text.indexOf("const requestFolderChange =");
    const confirmFolder = source.text.indexOf("const confirmFolderSwitch =");
    const folderMutation = source.text.indexOf("await switchFolder.mutateAsync", confirmFolder);
    expect(requestFolder).toBeGreaterThan(-1);
    expect(confirmFolder).toBeGreaterThan(requestFolder);
    expect(source.text.slice(requestFolder, confirmFolder)).not.toContain("mutate");
    expect(folderMutation).toBeGreaterThan(confirmFolder);

    const folderSelect = elementWith(inbox, "select", "defaultValue", '{settings.bookmarkFolderId ?? ""}');
    expect(attribute(folderSelect, "disabled")).toBe("{busy}");

    const pickerButtons = inbox.filter(
      (element) =>
        tag(element) === "button" && attribute(element, "onClick") === "{() => setPicking(true)}",
    );
    expect(pickerButtons).toHaveLength(2);
    for (const button of pickerButtons) expect(attribute(button, "disabled")).toBe("{busy}");

    const syncButton = elementWith(inbox, "button", "onClick", "{onSync}");
    expect(attribute(syncButton, "disabled")).toBe("{busy}");

    const folderBar = elementWith(inbox, "FolderBar", "busy", "{lifecycleBusy}");
    expect(attribute(folderBar, "syncing")).toBe("{sync.isPending || switchFolder.isPending}");
  });

  it("reconciles account-owned tab state before enabling a paid own-post query", async () => {
    const source = (await parseWebFile("Inbox.tsx")).text;
    const reconciliation = source.indexOf(
      "const accountTab = reconcileAccountTab(storedTab, accountGeneration);",
    );
    const paidQuery = source.indexOf(
      'useOwnPosts(accountGeneration, scan, tab === "yours" && authorized)',
    );
    expect(reconciliation).toBeGreaterThan(-1);
    expect(paidQuery).toBeGreaterThan(reconciliation);
  });

  it("uses a modal dialog with labelled copy, safe initial focus and keyboard cancellation", async () => {
    const source = await parseWebFile("Inbox.tsx");
    const inbox = openings(source);
    const dialog = elementWith(inbox, "dialog", "aria-modal", '"true"');
    expect(attribute(dialog, "aria-labelledby")).toBe("{DIALOG_TITLE_ID}");
    expect(attribute(dialog, "aria-describedby")).toBe("{DIALOG_DETAIL_ID}");
    expect(attribute(dialog, "onCancel")).toBe("{cancel}");
    expect(source.text).toContain("dialog.showModal()");
    expect(source.text).toContain("cancelRef.current?.focus()");
    expect(source.text).toContain("document.activeElement !== document.body");
    expect(source.text).toContain("previousFocus?.focus()");
    expect(source.text).toContain("Keep as local saves");
    expect(source.text).toContain("Remove from this app");
    expect(source.text).toContain("Disconnect and keep local saves");
    expect(source.text).toContain("Disconnect and remove synced saves");
    expect(source.text).toContain("Continue reconnecting");
    expect(source.text).toContain("Cancel");
  });

  it("wires each inbox tab to its labelled panel", async () => {
    const inbox = openings(await parseWebFile("Inbox.tsx"));
    const tablist = elementWith(inbox, "div", "role", '"tablist"');
    expect(attribute(tablist, "aria-label")).toBe('"Inbox views"');

    const savedTab = elementWith(inbox, "button", "id", "{SAVED_TAB_ID}");
    expect(attribute(savedTab, "role")).toBe('"tab"');
    expect(attribute(savedTab, "aria-selected")).toBe('{tab === "saved"}');
    expect(attribute(savedTab, "aria-controls")).toBe("{SAVED_PANEL_ID}");

    const yoursTab = elementWith(inbox, "button", "id", "{YOURS_TAB_ID}");
    expect(attribute(yoursTab, "role")).toBe('"tab"');
    expect(attribute(yoursTab, "aria-selected")).toBe('{tab === "yours"}');
    expect(attribute(yoursTab, "aria-controls")).toBe("{YOURS_PANEL_ID}");

    const savedPanel = elementWith(inbox, "div", "id", "{SAVED_PANEL_ID}");
    expect(attribute(savedPanel, "role")).toBe('"tabpanel"');
    expect(attribute(savedPanel, "aria-labelledby")).toBe("{SAVED_TAB_ID}");
    expect(attribute(savedPanel, "hidden")).toBe('{tab !== "saved"}');

    const yoursPanel = elementWith(inbox, "div", "id", "{YOURS_PANEL_ID}");
    expect(attribute(yoursPanel, "role")).toBe('"tabpanel"');
    expect(attribute(yoursPanel, "aria-labelledby")).toBe("{YOURS_TAB_ID}");
    expect(attribute(yoursPanel, "hidden")).toBe('{tab !== "yours"}');
  });

  it("marks visual errors as alerts and asynchronous results as statuses", async () => {
    const sources = await Promise.all(
      ["App.tsx", "Inbox.tsx", "Thread.tsx", "main.tsx"].map(parseWebFile),
    );

    for (const source of sources) {
      const errors = openings(source).filter((element) => attribute(element, "className") === '"error"');
      expect(errors.length).toBeGreaterThan(0);
      for (const error of errors) expect(attribute(error, "role")).toBe('"alert"');
    }

    const inbox = openings(sources[1]!);
    const inboxAlerts = inbox.filter((element) => attribute(element, "role") === '"alert"');
    expect(inboxAlerts.some((element) => element.parent.getText().includes("settingsState.message"))).toBe(
      true,
    );
    expect(inboxAlerts.some((element) => element.parent.getText().includes("authQuery.error.message"))).toBe(
      true,
    );
    expect(
      inbox.some(
        (element) =>
          attribute(element, "role") ===
          '{folders.error ? "alert" : !folderList ? "status" : undefined}',
      ),
    ).toBe(true);

    const inboxStatuses = inbox.filter((element) => attribute(element, "role") === '"status"');
    expect(
      inboxStatuses.some((element) => element.parent.getText().includes("loading bookmark settings")),
    ).toBe(true);
    expect(inboxStatuses.some((element) => element.parent.getText().includes("syncNote"))).toBe(true);
    expect(inboxStatuses.some((element) => element.parent.getText().includes("costNote"))).toBe(true);
    expect(inboxStatuses.some((element) => element.parent.getText().includes("ownList.items.length"))).toBe(
      true,
    );

    const threadStatuses = openings(sources[2]!).filter(
      (element) => attribute(element, "role") === '"status"',
    );
    expect(threadStatuses.some((element) => element.parent.getText().includes("newCount"))).toBe(true);
  });
});

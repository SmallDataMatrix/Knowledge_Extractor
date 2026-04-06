import {
	App,
	ButtonComponent,
	DropdownComponent,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TextComponent,
	requestUrl,
} from "obsidian";

const OVERVIEW_TYPE = "Overview";
const MIN_CHUNK_LENGTH = 500;
const NOTICE_DURATION = 4000;
const CUSTOM_PRESET = "__custom__";
const FRONTMATTER_STATUS_KEY = "knowledge_extractor_status";
const FRONTMATTER_EXTRACTED_AT_KEY = "knowledge_extractor_extracted_at";
const FRONTMATTER_CARD_COUNT_KEY = "knowledge_extractor_card_count";
const FRONTMATTER_OVERVIEW_PATH_KEY = "knowledge_extractor_overview_path";
const EXTRACTION_BLOCK_START = "<!-- KNOWLEDGE_EXTRACTOR:START -->";
const EXTRACTION_BLOCK_END = "<!-- KNOWLEDGE_EXTRACTOR:END -->";

const API_PRESETS = {
	custom: { label: "Custom", endpoint: "" },
	openai: {
		label: "OpenAI",
		endpoint: "https://api.openai.com/v1/chat/completions",
		defaultModel: "gpt-4o-mini",
	},
	deepseek: {
		label: "DeepSeek",
		endpoint: "https://api.deepseek.com/chat/completions",
		defaultModel: "deepseek-chat",
	},
	kimi: {
		label: "Kimi",
		endpoint: "https://api.moonshot.cn/v1/chat/completions",
		defaultModel: "moonshot-v1-8k",
	},
} as const;

const MODEL_PRESETS = [
	"gpt-4o-mini",
	"gpt-4.1-mini",
	"gpt-4.1",
	"deepseek-chat",
	"deepseek-reasoner",
	"moonshot-v1-8k",
	"moonshot-v1-32k",
	"moonshot-v1-128k",
] as const;

const LANGUAGE_PROMPTS = {
	zh: {
		folderName: "Chinese",
		fileSuffix: "_ch.md",
		backboneFileName: "backbone_ch.md",
		label: "中文",
	},
	en: {
		folderName: "English",
		fileSuffix: "_en.md",
		backboneFileName: "backbone_en.md",
		label: "英文",
	},
} as const;

const DEFAULT_EXTRACTION_TYPES = ["Concept", "Skill", "Rule", "Issue", "Insight"] as const;

const EXTRACTION_TYPE_DESCRIPTIONS: Record<string, string> = {
	Concept: "解释它是什么，以及它如何运作。",
	Skill: "提炼能直接照着执行的操作步骤。",
	Rule: "提取必须遵守的约束、底线和正反例。",
	Issue: "记录具体问题、触发条件与解决方案。",
	Insight: "沉淀架构权衡、决策与关键洞察。",
};

type ApiProviderKey = keyof typeof API_PRESETS;
type LanguageKey = keyof typeof LANGUAGE_PROMPTS;
type SourceLabel = "manual" | "markdown";

interface ExtractionHistoryEntry {
	extractedAt: string;
	cardCount: number;
	overviewPath?: string;
}

interface SourceExtractionState {
	extracted: boolean;
	cardCount: number;
	overviewPath: string;
}

interface KnowledgeExtractorSettings {
	apiKey: string;
	apiProvider: ApiProviderKey;
	apiEndpoint: string;
	modelName: string;
	chunkMaxLength: number;
	outputFolderPath: string;
	promptDirectoryPath: string;
	enabledExtractionTypes: string[];
	extractionHistory: Record<string, ExtractionHistoryEntry>;
}

interface LegacyKnowledgeExtractorSettings extends Partial<KnowledgeExtractorSettings> {
	promptFolderPathZh?: string;
	promptFolderPathEn?: string;
	promptFilePath?: string;
	promptFilePathZh?: string;
	promptFilePathEn?: string;
}

interface ExtractionOptions {
	inputText: string;
	editor?: Editor;
	sourceFile?: TFile;
	sourceLabel: SourceLabel;
}

interface ApiTestResult {
	ok: boolean;
	message: string;
}

interface ParsedCard {
	type: string;
	title: string;
	content: string;
	tool: string[];
	domain: string[];
	architecture: string[];
}

interface PromptTypeFile {
	fileName: string;
	filePath: string;
}

const DEFAULT_SETTINGS: KnowledgeExtractorSettings = {
	apiKey: "",
	apiProvider: "custom",
	apiEndpoint: API_PRESETS.openai.endpoint,
	modelName: API_PRESETS.openai.defaultModel,
	chunkMaxLength: 3000,
	outputFolderPath: "AI Extracts",
	promptDirectoryPath: "KnowledgeExtractor",
	enabledExtractionTypes: [...DEFAULT_EXTRACTION_TYPES],
	extractionHistory: {},
};

function normalizeTypeKey(value: string): string {
	return value.trim().toLowerCase();
}

function sanitizeEnabledExtractionTypes(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [...DEFAULT_EXTRACTION_TYPES];
	}

	const filtered = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);

	return Array.from(new Set(filtered));
}

function slugifyTypeName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function buildTypeFileName(type: string, language: LanguageKey): string {
	const slug = slugifyTypeName(type);
	return slug ? `${slug}${LANGUAGE_PROMPTS[language].fileSuffix}` : "";
}

function inferTypeNameFromFileName(fileName: string): string {
	const normalized = fileName
		.toLowerCase()
		.replace(/_(?:ch|en)\.md$/i, "")
		.replace(/\.md$/i, "");

	const matchedDefault = DEFAULT_EXTRACTION_TYPES.find(
		(type) => slugifyTypeName(type) === normalized,
	);
	if (matchedDefault) {
		return matchedDefault;
	}

	return normalized
		.split(/[^a-zA-Z0-9]+/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ") || normalized;
}

function sortExtractionTypes(types: Iterable<string>): string[] {
	const defaultOrder = new Map(DEFAULT_EXTRACTION_TYPES.map((type, index) => [normalizeTypeKey(type), index]));
	return [...types].sort((left, right) => {
		const leftIndex = defaultOrder.get(normalizeTypeKey(left));
		const rightIndex = defaultOrder.get(normalizeTypeKey(right));
		if (leftIndex !== undefined && rightIndex !== undefined) {
			return leftIndex - rightIndex;
		}
		if (leftIndex !== undefined) {
			return -1;
		}
		if (rightIndex !== undefined) {
			return 1;
		}
		return left.localeCompare(right, "en", { sensitivity: "base" });
	});
}

function normalizeVaultPath(path: string): string {
	return path.trim().replace(/^\/+|\/+$/g, "");
}

function maskApiKey(key: string): string {
	if (!key) {
		return "";
	}
	const prefixMatch = key.match(/^([a-zA-Z]+-)/);
	const prefix = prefixMatch?.[1] ?? "";
	const rest = key.slice(prefix.length);
	if (rest.length <= 6) {
		return key;
	}
	return `${prefix}${rest.slice(0, 3)}${"•".repeat(rest.length - 6)}${rest.slice(-3)}`;
}

function getErrorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("status" in error)) {
		return undefined;
	}
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default class KnowledgeExtractorPlugin extends Plugin {
	settings!: KnowledgeExtractorSettings;
	statusBarItemEl!: HTMLElement;
	statusSourceEl!: HTMLSpanElement;
	statusDetailEl!: HTMLSpanElement;
	statusCardsEl!: HTMLSpanElement;
	stopStatusBarItemEl!: HTMLButtonElement;
	markdownViewActions = new WeakSet<MarkdownView>();
	activeJob: ExtractionJob | null = null;
	activeSourceName = "待命";
	activeSourceFile: TFile | null = null;
	activeCardCount = 0;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.statusBarItemEl = this.addStatusBarItem();
		this.buildStatusPanel();
		this.setIdleStatus();

		this.addRibbonIcon("brain-circuit", "知识提取助手（手动粘贴提取）", () => {
			new ManualPasteModal(this.app, this).open();
		});

		this.addCommand({
			id: "open-knowledge-extractor",
			name: "打开知识提取助手（手动粘贴提取）",
			editorCallback: (editor) => {
				new ManualPasteModal(this.app, this, editor).open();
			},
		});

		this.addCommand({
			id: "extract-current-markdown",
			name: "提取当前笔记或选中内容",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) {
					return false;
				}
				if (!checking) {
					void this.openExtractionFromMarkdownView(view);
				}
				return true;
			},
		});

		this.addCommand({
			id: "stop-current-extraction",
			name: "停止当前提取",
			checkCallback: (checking) => {
				if (!this.activeJob) {
					return false;
				}
				if (!checking) {
					this.cancelActiveExtraction();
				}
				return true;
			},
		});

		this.app.workspace.onLayoutReady(() => {
			this.attachMarkdownViewActions();
			this.refreshFileExplorerBadges();
		});
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.attachMarkdownViewActions();
				this.refreshFileExplorerBadges();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.handleTrackedFileRename(file, oldPath);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.handleTrackedFileDelete(file);
			}),
		);

		this.addSettingTab(new KnowledgeExtractorSettingTab(this.app, this));
	}

	onunload(): void {
		this.setIdleStatus();
	}

	async loadSettings(): Promise<void> {
		const saved = ((await this.loadData()) as LegacyKnowledgeExtractorSettings | null) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		this.settings.enabledExtractionTypes = sanitizeEnabledExtractionTypes(saved.enabledExtractionTypes);
		this.settings.promptDirectoryPath = this.derivePromptDirectoryPath(saved) || DEFAULT_SETTINGS.promptDirectoryPath;
		this.settings.extractionHistory = saved.extractionHistory && typeof saved.extractionHistory === "object"
			? saved.extractionHistory
			: {};
		this.settings.apiProvider = this.inferApiProvider(this.settings.apiEndpoint);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	inferApiProvider(endpoint: string): ApiProviderKey {
		const trimmed = endpoint.trim();
		for (const [key, preset] of Object.entries(API_PRESETS) as [ApiProviderKey, (typeof API_PRESETS)[ApiProviderKey]][]) {
			if (preset.endpoint && preset.endpoint === trimmed) {
				return key;
			}
		}
		return "custom";
	}

	derivePromptDirectoryPath(saved: LegacyKnowledgeExtractorSettings): string {
		const direct = normalizeVaultPath(saved.promptDirectoryPath ?? "");
		if (direct) {
			return direct;
		}

		const legacyCandidates = [
			saved.promptFolderPathZh,
			saved.promptFolderPathEn,
			saved.promptFilePathZh,
			saved.promptFilePathEn,
			saved.promptFilePath,
		];

		for (const candidate of legacyCandidates) {
			const normalized = normalizeVaultPath(candidate ?? "");
			if (!normalized) {
				continue;
			}

			const withoutFile = normalized.toLowerCase().endsWith(".md")
				? normalized.split("/").slice(0, -1).join("/")
				: normalized;
			if (!withoutFile) {
				continue;
			}

			const parts = withoutFile.split("/").filter((part) => part.length > 0);
			const lastPart = parts[parts.length - 1]?.toLowerCase();
			if (lastPart === LANGUAGE_PROMPTS.zh.folderName.toLowerCase() || lastPart === LANGUAGE_PROMPTS.en.folderName.toLowerCase()) {
				return parts.slice(0, -1).join("/");
			}
			return withoutFile;
		}

		return DEFAULT_SETTINGS.promptDirectoryPath;
	}

	async getAvailableExtractionTypes(): Promise<string[]> {
		const discovered = new Set<string>([
			...DEFAULT_EXTRACTION_TYPES,
			...sanitizeEnabledExtractionTypes(this.settings.enabledExtractionTypes),
		]);

		for (const language of Object.keys(LANGUAGE_PROMPTS) as LanguageKey[]) {
			const types = await this.getExtractionTypesFromPromptFolder(language);
			for (const type of types) {
				discovered.add(type);
			}
		}

		return sortExtractionTypes(discovered);
	}

	async getExtractionTypesFromPromptFolder(language: LanguageKey): Promise<string[]> {
		const folderPath = this.getLanguagePromptFolderPath(language);
		if (!folderPath) {
			return [];
		}

		try {
			const folder = await this.app.vault.adapter.list(folderPath);
			const types = folder.files
				.map((filePath) => filePath.split("/").pop() ?? "")
				.filter((fileName) => fileName.toLowerCase().endsWith(".md"))
				.filter((fileName) => fileName.toLowerCase() !== LANGUAGE_PROMPTS[language].backboneFileName.toLowerCase())
				.map((fileName) => inferTypeNameFromFileName(fileName))
				.filter((type) => normalizeTypeKey(type) !== normalizeTypeKey(OVERVIEW_TYPE));
			return sortExtractionTypes(types);
		} catch {
			return [];
		}
	}

	getLanguagePromptFolderPath(language: LanguageKey): string {
		const root = normalizeVaultPath(this.settings.promptDirectoryPath);
		return root ? `${root}/${LANGUAGE_PROMPTS[language].folderName}` : "";
	}

	async testApiConfiguration(): Promise<ApiTestResult> {
		const apiKey = this.settings.apiKey.trim();
		const endpoint = this.settings.apiEndpoint.trim();
		const modelName = this.settings.modelName.trim();

		if (!apiKey) {
			return { ok: false, message: "请先填写 API Key。" };
		}
		if (!endpoint) {
			return { ok: false, message: "请先填写 API Endpoint。" };
		}
		if (!modelName) {
			return { ok: false, message: "请先填写模型名称。" };
		}

		try {
			const response = await requestUrl({
				url: endpoint,
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: modelName,
					messages: [{ role: "user", content: "Reply with OK only." }],
				}),
			});

			const status = typeof response.status === "number" ? response.status : 200;
			if (status >= 400) {
				const errorMessage = this.extractApiErrorMessage(response.json) || `HTTP ${status}`;
				return { ok: false, message: this.formatApiTestFailure(errorMessage, status) };
			}

			const responseText = this.extractTestResponseText(response.json);
			return {
				ok: true,
				message: `连接成功，当前配置可用。${responseText ? ` 返回: ${responseText}` : ""}`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, message: this.formatApiTestFailure(message, getErrorStatus(error)) };
		}
	}

	extractApiErrorMessage(responseJson: unknown): string {
		const maybeResponse = responseJson as {
			error?: { message?: string };
			message?: string;
		};
		if (typeof maybeResponse?.error?.message === "string" && maybeResponse.error.message.trim()) {
			return maybeResponse.error.message.trim();
		}
		if (typeof maybeResponse?.message === "string" && maybeResponse.message.trim()) {
			return maybeResponse.message.trim();
		}
		return "";
	}

	formatApiTestFailure(message: string, status?: number): string {
		const normalized = message.toLowerCase();
		const combinedMessage = status ? `[HTTP ${status}] ${message}` : message;

		if (
			status === 401 ||
			status === 403 ||
			/(invalid api key|incorrect api key|unauthorized|authentication|forbidden|permission denied|api key)/.test(normalized)
		) {
			return `API Key 可能有误，或当前 Key 没有调用该模型/接口的权限：${combinedMessage}`;
		}
		if (
			status === 404 ||
			/(404|not found|no route|cannot post|unknown url|unknown endpoint|invalid url)/.test(normalized)
		) {
			return `API Endpoint 可能有误：${combinedMessage}`;
		}
		if (
			/(model does not exist|unknown model|unsupported model|invalid model|model not found|no such model)/.test(normalized) ||
			(status === 400 && /model/.test(normalized))
		) {
			return `模型名称可能有误，或当前接口不支持这个模型：${combinedMessage}`;
		}
		if (
			/(enotfound|econnrefused|econnreset|timed out|timeout|network|fetch failed|dns|socket|certificate|tls|unable to resolve|connect)/.test(normalized)
		) {
			return `网络或连接失败，请检查网络、代理、证书或服务地址：${combinedMessage}`;
		}
		if (status === 429 || /(rate limit|too many requests|quota|insufficient quota)/.test(normalized)) {
			return `请求被限流，或当前账号额度不足：${combinedMessage}`;
		}
		if (status === 400) {
			return `请求格式有误，可能是模型名、Endpoint 协议或参数不匹配：${combinedMessage}`;
		}
		return `连接失败：${combinedMessage}`;
	}

	extractTestResponseText(responseJson: unknown): string {
		const content = (responseJson as {
			choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
		})?.choices?.[0]?.message?.content;

		if (typeof content === "string") {
			return content.trim().slice(0, 80);
		}
		if (Array.isArray(content)) {
			return content
				.map((part) => part?.text)
				.filter((part): part is string => typeof part === "string" && part.length > 0)
				.join(" ")
				.trim()
				.slice(0, 80);
		}
		return "";
	}

	async runExtraction(options: ExtractionOptions): Promise<void> {
		if (this.activeJob) {
			new Notice("⚠️ 当前已有提取任务在运行，请先等待完成或点击“停止”。", NOTICE_DURATION);
			return;
		}

		const job = new ExtractionJob(this, options);
		this.activeSourceName = this.getSourceDisplayName(options);
		this.activeSourceFile = options.sourceFile ?? null;
		this.activeCardCount = 0;
		this.setStatusMessage("准备提取...");
		this.activeJob = job;
		this.stopStatusBarItemEl.style.display = "";

		try {
			await job.run();
		} finally {
			this.activeJob = null;
			this.stopStatusBarItemEl.style.display = "none";
		}
	}

	cancelActiveExtraction(): void {
		if (!this.activeJob) {
			new Notice("当前没有正在运行的提取任务。", NOTICE_DURATION);
			return;
		}
		this.activeJob.cancel();
		this.setStatusMessage("正在停止...");
		new Notice("⏹️ 已请求停止，当前分块完成后会中断。", NOTICE_DURATION);
	}

	buildStatusPanel(): void {
		this.statusBarItemEl.empty();
		this.statusBarItemEl.classList.add("knowledge-extractor-status-panel");
		this.statusBarItemEl.style.display = "flex";
		this.statusBarItemEl.style.alignItems = "center";
		this.statusBarItemEl.style.gap = "10px";

		this.statusSourceEl = document.createElement("span");
		this.statusSourceEl.classList.add("knowledge-extractor-status-source");
		this.statusSourceEl.addEventListener("click", () => {
			void this.openActiveSourceFile();
		});

		this.statusDetailEl = document.createElement("span");
		this.statusCardsEl = document.createElement("span");

		this.stopStatusBarItemEl = document.createElement("button");
		this.stopStatusBarItemEl.classList.add("knowledge-extractor-stop-button");
		this.stopStatusBarItemEl.textContent = "停止";
		this.stopStatusBarItemEl.style.display = "none";
		this.stopStatusBarItemEl.addEventListener("click", () => {
			this.cancelActiveExtraction();
		});

		this.statusBarItemEl.append(
			this.statusSourceEl,
			this.statusDetailEl,
			this.statusCardsEl,
			this.stopStatusBarItemEl,
		);
	}

	setIdleStatus(): void {
		this.activeSourceName = "待命";
		this.activeSourceFile = null;
		this.activeCardCount = 0;
		this.statusSourceEl.textContent = "来源: 待命";
		this.statusDetailEl.textContent = "状态: 等待提取任务";
		this.statusCardsEl.textContent = "卡片: 0";
		this.updateSourceLinkState();
	}

	setProgressStatus(current: number, total: number, cardCount: number): void {
		const safeTotal = Math.max(total, 1);
		const safeCurrent = Math.max(0, Math.min(current, safeTotal));
		this.activeCardCount = cardCount;
		this.statusSourceEl.textContent = `来源: ${this.activeSourceName}`;
		this.statusDetailEl.textContent = `分块: ${safeCurrent}/${safeTotal}`;
		this.statusCardsEl.textContent = `卡片: ${cardCount}`;
		this.updateSourceLinkState();
	}

	setStatusMessage(message: string): void {
		this.statusSourceEl.textContent = `来源: ${this.activeSourceName}`;
		this.statusDetailEl.textContent = `状态: ${message}`;
		this.statusCardsEl.textContent = `卡片: ${this.activeCardCount}`;
		this.updateSourceLinkState();
	}

	updateSourceLinkState(): void {
		if (this.activeSourceFile) {
			this.statusSourceEl.style.cursor = "pointer";
			this.statusSourceEl.style.textDecoration = "underline";
			this.statusSourceEl.title = `点击打开源文件: ${this.activeSourceFile.path}`;
			return;
		}
		this.statusSourceEl.style.cursor = "default";
		this.statusSourceEl.style.textDecoration = "none";
		this.statusSourceEl.title = "";
	}

	async openActiveSourceFile(): Promise<void> {
		if (!this.activeSourceFile) {
			return;
		}
		const currentFile = this.app.vault.getAbstractFileByPath(this.activeSourceFile.path);
		if (!(currentFile instanceof TFile)) {
			new Notice("⚠️ 找不到当前任务关联的源文件。", NOTICE_DURATION);
			return;
		}
		const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(true);
		await leaf.openFile(currentFile);
	}

	refreshFileExplorerBadges(): void {
		window.requestAnimationFrame(() => {
			const navFileTitles = document.querySelectorAll<HTMLElement>(".nav-file-title[data-path], .tree-item-self.nav-file-title[data-path]");
			navFileTitles.forEach((titleEl) => {
				const filePath = titleEl.dataset.path ?? "";
				const abstractFile = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;
				const isMarkdownFile = abstractFile instanceof TFile && abstractFile.extension.toLowerCase() === "md";
				const isExtracted = isMarkdownFile ? this.isSourceFileMarkedExtracted(abstractFile) : false;
				titleEl.classList.toggle("knowledge-extractor-source-done", isExtracted);
				titleEl.classList.toggle("knowledge-extractor-source-pending", isMarkdownFile && !isExtracted);
				this.renderFileExplorerBadge(titleEl, isMarkdownFile ? (isExtracted ? "done" : "pending") : null);
			});
		});
	}

	renderFileExplorerBadge(titleEl: HTMLElement, state: "done" | "pending" | null): void {
		const targetEl = titleEl.querySelector<HTMLElement>(".nav-file-title-content, .tree-item-inner");
		if (!targetEl) {
			return;
		}

		let badgeEl = titleEl.querySelector<HTMLElement>(".knowledge-extractor-tree-badge");
		if (!state) {
			badgeEl?.remove();
			return;
		}

		if (!badgeEl) {
			badgeEl = document.createElement("span");
			badgeEl.className = "knowledge-extractor-tree-badge";
			badgeEl.setAttribute("aria-hidden", "true");
			targetEl.prepend(badgeEl);
		}

		badgeEl.classList.toggle("is-done", state === "done");
		badgeEl.classList.toggle("is-pending", state === "pending");
		badgeEl.textContent = state === "done" ? "✓" : "";
		badgeEl.title = state === "done" ? "已提取" : "待提取";
	}

	isSourceFileMarkedExtracted(file: TFile): boolean {
		if (this.settings.extractionHistory[file.path]) {
			return true;
		}
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return frontmatter?.[FRONTMATTER_STATUS_KEY] === "extracted";
	}

	handleTrackedFileRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) {
			return;
		}
		const existing = this.settings.extractionHistory[oldPath];
		if (!existing) {
			return;
		}
		delete this.settings.extractionHistory[oldPath];
		this.settings.extractionHistory[file.path] = existing;
		void this.saveSettings();
		this.refreshFileExplorerBadges();
	}

	handleTrackedFileDelete(file: TAbstractFile): void {
		if (!this.settings.extractionHistory[file.path]) {
			return;
		}
		delete this.settings.extractionHistory[file.path];
		void this.saveSettings();
		this.refreshFileExplorerBadges();
	}

	attachMarkdownViewActions(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) {
				continue;
			}
			if (this.markdownViewActions.has(view)) {
				continue;
			}
			view.addAction("brain-circuit", "提取当前笔记或选中内容", () => {
				void this.openExtractionFromMarkdownView(view);
			});
			this.markdownViewActions.add(view);
		}
	}

	async openExtractionFromMarkdownView(view: MarkdownView): Promise<void> {
		const file = view.file;
		if (!(file instanceof TFile)) {
			new Notice("⚠️ 当前视图没有关联的 Markdown 文件。", NOTICE_DURATION);
			return;
		}

		const inputText = await this.getInputTextFromView(view);
		if (!inputText) {
			new Notice("⚠️ 当前笔记没有可供提取的内容。", NOTICE_DURATION);
			return;
		}

		const extractionState = await this.getSourceExtractionState(file);
		if (extractionState.extracted) {
			const deletionCountText = extractionState.cardCount > 0
				? `\n会删除已经提取的 ${extractionState.cardCount} 张卡片。`
				: "\n会删除已经提取的关联卡片。";
			const confirmed = await new ConfirmModal(
				this.app,
				"该笔记已经提取过",
				`当前笔记已经有提取标记了。要继续重新提取并更新顶部链接吗？${deletionCountText}`
				, "重新提取",
			).openAndWait();
			if (!confirmed) {
				new Notice("已取消重新提取。", NOTICE_DURATION);
				return;
			}

			const removedCount = await this.removeExistingExtractionArtifacts(file, extractionState);
			await this.clearSourceFileExtraction(file);
			new Notice(`🧹 已清理 ${removedCount} 张旧卡片，开始重新提取。`, NOTICE_DURATION);
		}

		new Notice("🧭 提取进度会显示在 Obsidian 底部状态栏。", NOTICE_DURATION);
		await this.runExtraction({
			inputText,
			editor: view.editor,
			sourceFile: file,
			sourceLabel: "markdown",
		});
	}

	async getInputTextFromView(view: MarkdownView): Promise<string> {
		const selection = view.editor?.getSelection()?.trim();
		if (selection) {
			return selection;
		}
		const file = view.file;
		if (!(file instanceof TFile)) {
			return "";
		}
		return this.removeManagedFrontmatterKeys(this.stripManagedExtractionContent(await this.app.vault.read(file))).trim();
	}

	async isSourceFileExtracted(file: TFile): Promise<boolean> {
		return (await this.getSourceExtractionState(file)).extracted;
	}

	async getSourceExtractionState(file: TFile): Promise<SourceExtractionState> {
		const tracked = this.settings.extractionHistory[file.path];
		const metadataCache = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const metadataStatus = typeof metadataCache?.[FRONTMATTER_STATUS_KEY] === "string"
			? metadataCache[FRONTMATTER_STATUS_KEY]
			: undefined;
		const metadataCardCount = typeof metadataCache?.[FRONTMATTER_CARD_COUNT_KEY] === "number"
			? metadataCache[FRONTMATTER_CARD_COUNT_KEY]
			: Number.parseInt(String(metadataCache?.[FRONTMATTER_CARD_COUNT_KEY] ?? ""), 10);
		const metadataOverviewPath = typeof metadataCache?.[FRONTMATTER_OVERVIEW_PATH_KEY] === "string"
			? metadataCache[FRONTMATTER_OVERVIEW_PATH_KEY]
			: "";

		return {
			extracted: Boolean(tracked) || metadataStatus === "extracted",
			cardCount: tracked?.cardCount ?? (Number.isFinite(metadataCardCount) ? metadataCardCount : 0),
			overviewPath: tracked?.overviewPath ?? metadataOverviewPath,
		};
	}

	async markSourceFileExtracted(file: TFile, overviewPath: string, atomicPaths: string[]): Promise<void> {
		const extractedAt = new Date().toISOString();
		const cardCount = atomicPaths.length + 1;
		await this.app.vault.process(file, (content) =>
			this.upsertSourceExtractionInfo(content, {
				extractedAt,
				cardCount,
				overviewPath,
				atomicPaths,
			}),
		);
		this.settings.extractionHistory[file.path] = {
			extractedAt,
			cardCount,
			overviewPath,
		};
		await this.saveSettings();
		this.refreshFileExplorerBadges();
	}

	async clearSourceFileExtraction(file: TFile): Promise<void> {
		await this.app.vault.process(file, (content) => this.removeSourceExtractionInfo(content));
		delete this.settings.extractionHistory[file.path];
		await this.saveSettings();
		this.refreshFileExplorerBadges();
	}

	async removeExistingExtractionArtifacts(file: TFile, state?: SourceExtractionState): Promise<number> {
		const extractionState = state ?? await this.getSourceExtractionState(file);
		const sourceNoteLink = this.buildVaultLinkFromPath(file.path);
		const overviewLink = extractionState.overviewPath ? this.buildVaultLinkFromPath(extractionState.overviewPath) : "";
		const trackedPaths = new Set(await this.getExtractionArtifactPathsFromSourceFile(file));
		if (extractionState.overviewPath) {
			trackedPaths.add(extractionState.overviewPath);
		}

		const filesToDelete = new Map<string, TFile>();
		for (const trackedPath of trackedPaths) {
			const candidate = trackedPath ? this.app.vault.getAbstractFileByPath(trackedPath) : null;
			if (candidate instanceof TFile) {
				filesToDelete.set(candidate.path, candidate);
			}
		}

		const outputFolderPath = normalizeVaultPath(this.settings.outputFolderPath);
		for (const candidate of this.app.vault.getMarkdownFiles()) {
			if (candidate.path === file.path || filesToDelete.has(candidate.path)) {
				continue;
			}
			if (outputFolderPath && !candidate.path.startsWith(`${outputFolderPath}/`)) {
				continue;
			}
			const content = await this.app.vault.cachedRead(candidate);
			const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
			if (!frontmatterMatch) {
				continue;
			}
			const frontmatterBody = frontmatterMatch[1] ?? "";
			const hasSourceNoteMatch = frontmatterBody.includes("source_note:") && frontmatterBody.includes(sourceNoteLink);
			const hasOverviewSourceMatch = overviewLink.length > 0
				&& frontmatterBody.includes("source:")
				&& frontmatterBody.includes(overviewLink);
			if (hasSourceNoteMatch || hasOverviewSourceMatch) {
				filesToDelete.set(candidate.path, candidate);
			}
		}

		let deletedCount = 0;
		for (const target of filesToDelete.values()) {
			try {
				await this.app.vault.delete(target, true);
				deletedCount += 1;
			} catch (error) {
				console.error("删除旧提取文件失败:", error);
				new Notice(`⚠️ 删除旧卡片失败: ${target.path}`, NOTICE_DURATION);
			}
		}
		return deletedCount;
	}

	async getExtractionArtifactPathsFromSourceFile(file: TFile): Promise<string[]> {
		const content = await this.app.vault.cachedRead(file);
		const blockMatch = content.match(new RegExp(`${escapeRegExp(EXTRACTION_BLOCK_START)}([\\s\\S]*?)${escapeRegExp(EXTRACTION_BLOCK_END)}`, "m"));
		if (!blockMatch) {
			return [];
		}
		const blockBody = blockMatch[1] ?? "";
		const linkMatches = Array.from(blockBody.matchAll(/\[\[([^\]]+)\]\]/g));
		return Array.from(new Set(
			linkMatches
				.map((match) => this.resolveVaultPathFromLink(match[1] ?? ""))
				.filter((artifactPath) => artifactPath.length > 0),
		));
	}

	resolveVaultPathFromLink(linkText: string): string {
		const cleaned = linkText
			.split("|")[0]
			?.trim()
			.replace(/#.*$/, "")
			.replace(/\.md$/i, "") ?? "";
		return cleaned ? `${cleaned}.md` : "";
	}

	upsertSourceExtractionInfo(
		content: string,
		metadata: { extractedAt: string; cardCount: number; overviewPath: string; atomicPaths: string[] },
	): string {
		const withFrontmatter = this.upsertFrontmatter(content, {
			[FRONTMATTER_STATUS_KEY]: "extracted",
			[FRONTMATTER_EXTRACTED_AT_KEY]: metadata.extractedAt,
			[FRONTMATTER_CARD_COUNT_KEY]: metadata.cardCount,
			[FRONTMATTER_OVERVIEW_PATH_KEY]: metadata.overviewPath,
		});
		return this.upsertExtractionIntroBlock(withFrontmatter, metadata.overviewPath, metadata.atomicPaths);
	}

	upsertFrontmatter(content: string, updates: Record<string, string | number>): string {
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
		if (!frontmatterMatch) {
			const newFields = Object.entries(updates)
				.map(([key, value]) => `${key}: ${this.formatFrontmatterValue(value)}`)
				.join("\n");
			return `---\n${newFields}\n---\n\n${content}`;
		}

		const existingBody = frontmatterMatch[1] ?? "";
		const contentAfterFrontmatter = content.slice(frontmatterMatch[0].length);
		const updatedKeys = new Set<string>();
		const updatedLines = existingBody.split("\n").map((line) => {
			const keyMatch = line.match(/^([A-Za-z0-9_-]+):/);
			if (!keyMatch) {
				return line;
			}
			const key = keyMatch[1];
			if (!key || !(key in updates)) {
				return line;
			}
			updatedKeys.add(key);
			const updateValue = updates[key];
			if (updateValue === undefined) {
				return line;
			}
			return `${key}: ${this.formatFrontmatterValue(updateValue)}`;
		});

		for (const [key, value] of Object.entries(updates)) {
			if (!updatedKeys.has(key)) {
				updatedLines.push(`${key}: ${this.formatFrontmatterValue(value)}`);
			}
		}

		return `---\n${updatedLines.join("\n")}\n---${contentAfterFrontmatter}`;
	}

	formatFrontmatterValue(value: string | number): string {
		if (typeof value === "number") {
			return String(value);
		}
		return JSON.stringify(value);
	}

	upsertExtractionIntroBlock(content: string, overviewPath: string, atomicPaths: string[]): string {
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
		const frontmatter = frontmatterMatch?.[0] ?? "";
		const body = frontmatterMatch ? content.slice(frontmatter.length) : content;
		const blockPattern = new RegExp(`${escapeRegExp(EXTRACTION_BLOCK_START)}[\\s\\S]*?${escapeRegExp(EXTRACTION_BLOCK_END)}\\n*`, "g");
		const cleanedBody = body.replace(blockPattern, "").replace(/^\n+/, "");
		const introBlock = this.buildSourceExtractionBlock(overviewPath, atomicPaths);
		return `${frontmatter}${introBlock}${cleanedBody}`;
	}

	removeSourceExtractionInfo(content: string): string {
		const withoutIntroBlock = this.stripManagedExtractionContent(content);
		return this.removeManagedFrontmatterKeys(withoutIntroBlock);
	}

	stripManagedExtractionContent(content: string): string {
		const blockPattern = new RegExp(`${escapeRegExp(EXTRACTION_BLOCK_START)}[\\s\\S]*?${escapeRegExp(EXTRACTION_BLOCK_END)}\\n*`, "g");
		return content.replace(blockPattern, "").replace(/^\n+/, "");
	}

	removeManagedFrontmatterKeys(content: string): string {
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
		if (!frontmatterMatch) {
			return content;
		}

		const keysToRemove = new Set([
			FRONTMATTER_STATUS_KEY,
			FRONTMATTER_EXTRACTED_AT_KEY,
			FRONTMATTER_CARD_COUNT_KEY,
			FRONTMATTER_OVERVIEW_PATH_KEY,
		]);
		const existingBody = frontmatterMatch[1] ?? "";
		const contentAfterFrontmatter = content.slice(frontmatterMatch[0].length);
		const remainingLines = existingBody
			.split("\n")
			.filter((line) => {
				const keyMatch = line.match(/^([A-Za-z0-9_-]+):/);
				return !(keyMatch && keysToRemove.has(keyMatch[1] ?? ""));
			})
			.filter((line, index, lines) => !(line.trim() === "" && lines[index - 1]?.trim() === ""));

		if (remainingLines.length === 0 || remainingLines.every((line) => line.trim().length === 0)) {
			return contentAfterFrontmatter.replace(/^\n+/, "");
		}

		return `---\n${remainingLines.join("\n")}\n---\n${contentAfterFrontmatter.replace(/^\n+/, "")}`;
	}

	buildSourceExtractionBlock(overviewPath: string, atomicPaths: string[]): string {
		const overviewLink = this.buildVaultLinkFromPath(overviewPath);
		const lines = [EXTRACTION_BLOCK_START, `> Overview: ${overviewLink}`];
		if (atomicPaths.length > 0) {
			lines.push(`> Cards: ${atomicPaths.map((filePath) => this.buildVaultLinkFromPath(filePath)).join(" ")}`);
		}
		lines.push(EXTRACTION_BLOCK_END, "");
		return `${lines.join("\n")}\n`;
	}

	buildVaultLinkFromPath(filePath: string): string {
		return `[[${filePath.replace(/\.md$/i, "")}]]`;
	}

	getSourceDisplayName(options: ExtractionOptions): string {
		if (options.sourceFile instanceof TFile) {
			return options.sourceFile.basename;
		}
		if (options.sourceLabel === "manual") {
			return "手动粘贴文本";
		}
		return "当前笔记";
	}
}

class ManualPasteModal extends Modal {
	plugin: KnowledgeExtractorPlugin;
	editor: Editor | undefined;
	inputText: string;

	constructor(app: App, plugin: KnowledgeExtractorPlugin, editor?: Editor, initialText = "") {
		super(app);
		this.plugin = plugin;
		this.editor = editor;
		this.inputText = initialText;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "🧠 知识提取助手（手动粘贴）" });

		const hint = contentEl.createEl("p", {
			text: "这里是手动文本提取入口。当前笔记提取请使用 Markdown 视图右上角按钮。",
		});
		hint.style.marginTop = "0";

		const textarea = contentEl.createEl("textarea", {
			attr: {
				placeholder: "请在此粘贴需要处理的技术文章、笔记或段落...",
				rows: "10",
			},
		});
		textarea.classList.add("knowledge-extractor-textarea");
		textarea.value = this.inputText;
		textarea.addEventListener("input", (event) => {
			this.inputText = (event.target as HTMLTextAreaElement).value;
		});

		contentEl
			.createEl("button", { text: "🚀 一键提取并拆分入库", cls: "mod-cta" })
			.addEventListener("click", () => {
				if (!this.inputText.trim()) {
					new Notice("请输入内容！", NOTICE_DURATION);
					return;
				}
				new Notice("🧭 提取进度会显示在 Obsidian 底部状态栏。", NOTICE_DURATION);
				void this.plugin.runExtraction({
					inputText: this.inputText,
					editor: this.editor,
					sourceLabel: "manual",
				});
				this.close();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ExtractionJob {
	plugin: KnowledgeExtractorPlugin;
	app: App;
	options: ExtractionOptions;
	cancellationRequested = false;

	constructor(plugin: KnowledgeExtractorPlugin, options: ExtractionOptions) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.options = options;
	}

	cancel(): void {
		this.cancellationRequested = true;
	}

	async run(): Promise<void> {
		if (!this.plugin.settings.apiKey.trim()) {
			new Notice("❌ 请先在插件设置中配置 API Key", NOTICE_DURATION);
			this.plugin.setStatusMessage("缺少 API Key");
			return;
		}
		if (!this.plugin.settings.apiEndpoint.trim()) {
			new Notice("❌ 请先在插件设置中配置 API Endpoint", NOTICE_DURATION);
			this.plugin.setStatusMessage("缺少 API Endpoint");
			return;
		}
		if (!this.plugin.settings.modelName.trim()) {
			new Notice("❌ 请先在插件设置中配置模型名称", NOTICE_DURATION);
			this.plugin.setStatusMessage("缺少模型名称");
			return;
		}

		const requestedTypes = this.getRequestedExtractionTypes();
		const prompt = await this.loadPrompt(this.options.inputText, requestedTypes);
		if (!prompt) {
			this.plugin.setStatusMessage("未找到可用 Prompt");
			return;
		}

		const chunks = this.splitTextIntoChunks(this.options.inputText);
		if (chunks.length === 0) {
			new Notice("⚠️ 没有可供提取的内容。", NOTICE_DURATION);
			this.plugin.setStatusMessage("没有可提取内容");
			return;
		}

		this.plugin.setProgressStatus(0, chunks.length, 0);

		let completedCount = 0;
		let parsedCardCount = 0;

		try {
			const chunkResults = await Promise.all(
				chunks.map(async (chunk, index) => {
					if (this.cancellationRequested) {
						completedCount += 1;
						this.plugin.setProgressStatus(completedCount, chunks.length, parsedCardCount);
						return [] as ParsedCard[];
					}

					try {
						const rawResponse = await this.callLLM(chunk, prompt);
						if (!rawResponse) {
							new Notice(`⚠️ 第 ${index + 1} 部分返回空内容，已跳过。`, NOTICE_DURATION);
							return [] as ParsedCard[];
						}

						if (this.cancellationRequested) {
							return [] as ParsedCard[];
						}

						const parsedCards = this.filterParsedCardsByType(this.parseJsonCards(rawResponse), requestedTypes);
						parsedCardCount += parsedCards.length;
						return parsedCards;
					} catch (error) {
						console.error("提取失败:", error);
						new Notice(`⚠️ 第 ${index + 1} 部分请求失败，已跳过。`, NOTICE_DURATION);
						return [] as ParsedCard[];
					} finally {
						completedCount += 1;
						this.plugin.setProgressStatus(completedCount, chunks.length, parsedCardCount);
					}
				}),
			);

			if (this.shouldStop()) {
				return;
			}

			const allCards = chunkResults.flat();
			if (allCards.length === 0) {
				new Notice("⚠️ 全部请求完成，但没有生成可保存的卡片。", NOTICE_DURATION);
				this.plugin.setStatusMessage("已完成，但未生成卡片");
				return;
			}

			const savedFiles = await this.saveCardsToVault(allCards);
			if (this.shouldStop()) {
				return;
			}
			if (savedFiles.length === 0) {
				this.plugin.setStatusMessage("已完成，但未生成卡片");
				return;
			}

			const [overviewPath, ...atomicPaths] = savedFiles;
			if (this.options.sourceFile && overviewPath) {
				await this.plugin.markSourceFileExtracted(this.options.sourceFile, overviewPath, atomicPaths);
			}

			this.plugin.activeCardCount = savedFiles.length;
			this.plugin.setStatusMessage(`提取完成，共生成 ${savedFiles.length} 张卡片`);
			new Notice(`🎉 全部提取完成！共生成 ${savedFiles.length} 张卡片。`, NOTICE_DURATION);
		} catch (error) {
			console.error("提取失败:", error);
			this.plugin.setStatusMessage("提取失败，请查看控制台");
			new Notice("❌ 提取失败，请检查网络、API 配置或控制台日志", NOTICE_DURATION);
		}
	}

	shouldStop(): boolean {
		if (!this.cancellationRequested) {
			return false;
		}
		this.plugin.setStatusMessage("提取已停止");
		new Notice("⏹️ 提取已停止。", NOTICE_DURATION);
		return true;
	}

	async loadPrompt(inputText: string, requestedTypes: string[]): Promise<string | null> {
		const language: LanguageKey = this.isChineseText(inputText) ? "zh" : "en";
		const prompt = await this.readPromptBundleFromFolder(language, requestedTypes);
		if (prompt) {
			new Notice(`🔍 检测到${LANGUAGE_PROMPTS[language].label}输入，已加载对应模板。`, NOTICE_DURATION);
			return prompt;
		}

		new Notice(
			`❌ 找不到 ${LANGUAGE_PROMPTS[language].label} Prompt 模板。请检查“Prompt目录路径”下的 ${LANGUAGE_PROMPTS[language].folderName} 子目录。`,
			NOTICE_DURATION,
		);
		return null;
	}

	async readPromptBundleFromFolder(language: LanguageKey, requestedTypes: string[]): Promise<string | null> {
		const folderPath = this.plugin.getLanguagePromptFolderPath(language);
		if (!folderPath) {
			return null;
		}

		const backbonePath = `${folderPath}/${LANGUAGE_PROMPTS[language].backboneFileName}`;
		const backbone = await this.readPromptFromPath(backbonePath);
		if (!backbone) {
			return null;
		}

		const pieces = [backbone.trim()];
		const missingTypes: string[] = [];
		const discoveredFiles = await this.discoverPromptTypeFiles(folderPath, language);

		for (const type of requestedTypes) {
			if (type === OVERVIEW_TYPE) {
				continue;
			}
			const normalizedType = normalizeTypeKey(type);
			const promptFilePath = discoveredFiles.get(normalizedType) ?? `${folderPath}/${buildTypeFileName(type, language)}`;
			const promptBody = await this.readPromptFromPath(promptFilePath);
			if (!promptBody) {
				missingTypes.push(type);
				continue;
			}
			pieces.push(promptBody.trim());
		}

		if (missingTypes.length > 0) {
			new Notice(`⚠️ 缺少分类模板：${missingTypes.join(", ")}。本轮将跳过这些类型的 Prompt 片段。`, NOTICE_DURATION);
		}

		pieces.push(this.buildTypeScopeInstructions(requestedTypes));
		return pieces.filter((piece) => piece.length > 0).join("\n\n").trim();
	}

	async discoverPromptTypeFiles(folderPath: string, language: LanguageKey): Promise<Map<string, string>> {
		try {
			const folder = await this.app.vault.adapter.list(folderPath);
			const files = folder.files.map((filePath) => ({
				fileName: filePath.split("/").pop() ?? "",
				filePath,
			} satisfies PromptTypeFile));

			return new Map(
				files
					.filter(({ fileName }) => fileName.toLowerCase().endsWith(".md"))
					.filter(({ fileName }) => fileName.toLowerCase() !== LANGUAGE_PROMPTS[language].backboneFileName.toLowerCase())
					.map(({ fileName, filePath }) => [normalizeTypeKey(inferTypeNameFromFileName(fileName)), filePath]),
			);
		} catch {
			return new Map();
		}
	}

	async readPromptFromPath(path: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return null;
		}
		return this.app.vault.read(file);
	}

	isChineseText(text: string): boolean {
		const chineseChars = text.match(/[\u4e00-\u9fff]/g);
		return (chineseChars?.length ?? 0) > 30;
	}

	getRequestedExtractionTypes(): string[] {
		return [OVERVIEW_TYPE, ...sanitizeEnabledExtractionTypes(this.plugin.settings.enabledExtractionTypes)];
	}

	buildTypeScopeInstructions(requestedTypes: string[]): string {
		const scopedTypes = requestedTypes.filter((type) => type !== OVERVIEW_TYPE);
		return [
			"## Extraction Scope",
			`- Always include: ${OVERVIEW_TYPE}.`,
			scopedTypes.length > 0
				? `- Additionally extract only these card types: ${scopedTypes.join(", ")}.`
				: "- Do not extract Concept, Skill, Rule, Issue, or Insight for this run.",
			"- Do not return card types outside the allowed scope.",
			"- If the source text does not strongly support an allowed type, omit it instead of guessing.",
		].join("\n");
	}

	getChunkMaxLength(): number {
		const configured = Math.floor(this.plugin.settings.chunkMaxLength);
		return Number.isFinite(configured) && configured >= MIN_CHUNK_LENGTH
			? configured
			: DEFAULT_SETTINGS.chunkMaxLength;
	}

	splitTextIntoChunks(text: string, maxLength = this.getChunkMaxLength()): string[] {
		const trimmed = text.trim();
		if (!trimmed) {
			return [];
		}
		if (trimmed.length <= maxLength) {
			return [trimmed];
		}

		const headingSegments = trimmed
			.split(/(?=^#{1,6}\s.+$)/gm)
			.map((segment) => segment.trim())
			.filter((segment) => segment.length > 0);

		const segments = headingSegments.length > 1
			? headingSegments
			: trimmed.split(/\n{2,}/).map((segment) => segment.trim()).filter((segment) => segment.length > 0);

		return this.packSegments(segments, maxLength);
	}

	packSegments(segments: string[], maxLength: number): string[] {
		const chunks: string[] = [];
		let currentChunk = "";

		for (const segment of segments) {
			if (segment.length > maxLength) {
				if (currentChunk) {
					chunks.push(currentChunk);
					currentChunk = "";
				}
				chunks.push(...this.splitOversizedSegment(segment, maxLength));
				continue;
			}

			const candidate = currentChunk ? `${currentChunk}\n\n${segment}` : segment;
			if (candidate.length > maxLength) {
				if (currentChunk) {
					chunks.push(currentChunk);
				}
				currentChunk = segment;
			} else {
				currentChunk = candidate;
			}
		}

		if (currentChunk) {
			chunks.push(currentChunk);
		}

		return chunks.length > 0 ? chunks : segments;
	}

	splitOversizedSegment(segment: string, maxLength: number): string[] {
		const paragraphs = segment
			.split(/\n{2,}/)
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (paragraphs.length > 1) {
			return this.packSegments(paragraphs, maxLength);
		}
		return this.splitBySentence(segment, maxLength);
	}

	splitBySentence(text: string, maxLength: number): string[] {
		const sentences =
			text
				.match(/[^。！？.!?\n]+[。！？.!?]?/g)
				?.map((sentence) => sentence.trim())
				.filter((sentence) => sentence.length > 0) ?? [text.trim()];

		const chunks: string[] = [];
		let currentChunk = "";

		for (const sentence of sentences) {
			if (sentence.length > maxLength) {
				if (currentChunk) {
					chunks.push(currentChunk);
					currentChunk = "";
				}
				for (let index = 0; index < sentence.length; index += maxLength) {
					chunks.push(sentence.slice(index, index + maxLength));
				}
				continue;
			}

			const candidate = currentChunk ? `${currentChunk} ${sentence}` : sentence;
			if (candidate.length > maxLength) {
				if (currentChunk) {
					chunks.push(currentChunk);
				}
				currentChunk = sentence;
			} else {
				currentChunk = candidate;
			}
		}

		if (currentChunk) {
			chunks.push(currentChunk);
		}

		return chunks;
	}

	async callLLM(userContent: string, systemPrompt: string): Promise<string | null> {
		const response = await requestUrl({
			url: this.plugin.settings.apiEndpoint,
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.plugin.settings.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.plugin.settings.modelName,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userContent },
				],
			}),
		});
		return this.getResponseText(response.json);
	}

	getResponseText(responseJson: unknown): string | null {
		const content = (responseJson as {
			choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
		})?.choices?.[0]?.message?.content;

		if (typeof content === "string") {
			return content;
		}
		if (Array.isArray(content)) {
			const joined = content
				.map((part) => part?.text)
				.filter((part): part is string => typeof part === "string" && part.length > 0)
				.join("\n")
				.trim();
			return joined || null;
		}
		return null;
	}

	parseJsonCards(text: string): ParsedCard[] {
		const cleaned = text
			.trim()
			.replace(/^```json\s*/i, "")
			.replace(/^```\s*/i, "")
			.replace(/\s*```$/, "")
			.trim();

		let parsed: unknown;
		try {
			parsed = JSON.parse(cleaned);
		} catch (error) {
			console.error("JSON 解析失败:", error, cleaned);
			new Notice("⚠️ 模型返回的不是合法 JSON，已跳过该分块。", NOTICE_DURATION);
			return [];
		}

		const cards = Array.isArray(parsed)
			? parsed
			: (parsed as { cards?: unknown[] } | null)?.cards ?? [];

		return cards
			.map((card, index) => this.normalizeParsedCard(card, index))
			.filter((card): card is ParsedCard => card !== null);
	}

	filterParsedCardsByType(cards: ParsedCard[], requestedTypes: string[]): ParsedCard[] {
		const allowed = new Set(requestedTypes.map((type) => normalizeTypeKey(type)));
		return cards.filter((card) => allowed.has(normalizeTypeKey(card.type)));
	}

	async saveCardsToVault(cards: ParsedCard[]): Promise<string[]> {
		const folderPath = this.normalizeFolderPath(this.plugin.settings.outputFolderPath);
		if (folderPath) {
			await this.ensureFolderExists(folderPath);
		}

		const overviewCards = cards.filter((card) => normalizeTypeKey(card.type) === normalizeTypeKey(OVERVIEW_TYPE));
		if (overviewCards.length === 0) {
			new Notice("❌ 提取失败：未找到任何 Overview 节点，已取消写入。", NOTICE_DURATION);
			return [];
		}
		if (overviewCards.length > 1) {
			new Notice(`🧩 检测到 ${overviewCards.length} 个 Overview，已自动合并为单一总览。`, NOTICE_DURATION);
		}

		const atomicCards = cards.filter((card) => normalizeTypeKey(card.type) !== normalizeTypeKey(OVERVIEW_TYPE));
		const masterOverview = overviewCards[0];
		if (!masterOverview) {
			new Notice("❌ 提取失败：无法确定总览卡片。", NOTICE_DURATION);
			return [];
		}

		const overviewPath = folderPath
			? `${folderPath}/${this.buildOverviewFileName(masterOverview)}`
			: this.buildOverviewFileName(masterOverview);
		const finalOverviewPath = this.getUniqueFileName(overviewPath);
		const overviewLink = this.buildVaultNoteLink(finalOverviewPath);
		const sourceNoteLink = this.options.sourceFile ? this.buildVaultNoteLink(this.options.sourceFile.path) : null;
		const createdAtomicPaths: string[] = [];
		const overviewChildLinks: string[] = [];

		for (const card of atomicCards) {
			const cardPath = folderPath
				? `${folderPath}/${this.buildCardFileName(card)}`
				: this.buildCardFileName(card);
			const finalCardPath = this.getUniqueFileName(cardPath);
			const fileContent = this.buildCardFileContent(card, { sourceLink: overviewLink, sourceNoteLink });

			try {
				await this.app.vault.create(finalCardPath, fileContent);
				createdAtomicPaths.push(finalCardPath);
				overviewChildLinks.push(this.buildVaultNoteLink(finalCardPath));
			} catch (error) {
				console.error("文件创建失败:", error);
				new Notice(`⚠️ 创建文件失败: ${finalCardPath}`, NOTICE_DURATION);
			}
		}

		const overviewContent = this.buildOverviewFileContent(overviewCards, overviewChildLinks, sourceNoteLink);
		try {
			await this.app.vault.create(finalOverviewPath, overviewContent);
		} catch (error) {
			console.error("Overview 创建失败:", error);
			new Notice(`⚠️ 创建 Overview 失败: ${finalOverviewPath}`, NOTICE_DURATION);
			return createdAtomicPaths;
		}

		return [finalOverviewPath, ...createdAtomicPaths];
	}

	normalizeParsedCard(rawCard: unknown, index: number): ParsedCard | null {
		if (!rawCard || typeof rawCard !== "object") {
			return null;
		}

		const card = rawCard as {
			type?: unknown;
			title?: unknown;
			content?: unknown;
			tool?: unknown;
			domain?: unknown;
			architecture?: unknown;
		};

		const title = typeof card.title === "string" && card.title.trim()
			? card.title.trim()
			: `未命名卡片_${Date.now()}_${index + 1}`;
		const content = typeof card.content === "string" ? card.content.trim() : "";
		if (!content) {
			return null;
		}

		return {
			type: typeof card.type === "string" && card.type.trim() ? card.type.trim() : "Unknown",
			title,
			content,
			tool: this.normalizeStringList(card.tool),
			domain: this.normalizeStringList(card.domain),
			architecture: this.normalizeStringList(card.architecture),
		};
	}

	normalizeStringList(value: unknown): string[] {
		if (Array.isArray(value)) {
			return value
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter((item) => item.length > 0);
		}
		if (typeof value === "string" && value.trim()) {
			return [value.trim()];
		}
		return [];
	}

	buildCardFileName(card: ParsedCard): string {
		const safeType = card.type.replace(/[\\/:*?"<>|]/g, "").trim() || "Unknown";
		const safeTitle = card.title.replace(/[\\/:*?"<>|]/g, "").trim() || `未命名卡片_${Date.now()}`;
		return `${safeType} - ${safeTitle}.md`;
	}

	buildOverviewFileName(card: ParsedCard): string {
		const safeTitle = card.title.replace(/[\\/:*?"<>|]/g, "").trim() || `未命名概述_${Date.now()}`;
		return `📄 ${safeTitle}.md`;
	}

	buildVaultNoteLink(filePath: string): string {
		return `[[${filePath.replace(/\.md$/i, "")}]]`;
	}

	buildCardFileContent(card: ParsedCard, options?: { sourceLink?: string; sourceNoteLink?: string | null }): string {
		const lines = ["---"];
		lines.push(...this.buildYamlList("type", [card.type]));
		lines.push(...this.buildYamlList("tool", card.tool));
		lines.push(...this.buildYamlList("domain", card.domain));
		lines.push(...this.buildYamlList("architecture", card.architecture));
		if (options?.sourceLink) {
			lines.push(...this.buildYamlList("source", [options.sourceLink]));
		}
		if (options?.sourceNoteLink) {
			lines.push(...this.buildYamlList("source_note", [options.sourceNoteLink]));
		}
		lines.push("---", "");
		return `${lines.join("\n")}# ${card.title}\n\n${card.content.trim()}\n`;
	}

	buildOverviewFileContent(overviewCards: ParsedCard[], childLinks: string[], sourceNoteLink: string | null): string {
		const firstOverview = overviewCards[0];
		if (!firstOverview) {
			return "";
		}

		const mergedDomains = Array.from(new Set(overviewCards.flatMap((card) => card.domain)));
		const mergedContent = overviewCards.length === 1
			? firstOverview.content.trim()
			: overviewCards
				.map((card, index) => `> **Part ${index + 1} 摘要**\n> ${card.content.trim().replace(/\n/g, "\n> ")}`)
				.join("\n\n");

		const lines = ["---"];
		lines.push(...this.buildYamlList("type", [OVERVIEW_TYPE]));
		lines.push(...this.buildYamlList("domain", mergedDomains));
		if (sourceNoteLink) {
			lines.push(...this.buildYamlList("source_note", [sourceNoteLink]));
		}
		lines.push("---", "");

		const linksSection = childLinks.length > 0
			? `\n\n### 🔗 提取出的原子知识点\n${childLinks.map((link) => `- ${link}`).join("\n")}`
			: "";

		return `${lines.join("\n")}# ${firstOverview.title}\n\n${mergedContent}${linksSection}\n`;
	}

	buildYamlList(key: string, values: string[]): string[] {
		if (values.length === 0) {
			return [`${key}: []`];
		}
		return [`${key}:`, ...values.map((value) => `  - ${JSON.stringify(value)}`)];
	}

	normalizeFolderPath(path: string): string {
		return normalizeVaultPath(path);
	}

	async ensureFolderExists(folderPath: string): Promise<void> {
		const parts = folderPath.split("/").filter((part) => part.length > 0);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	getUniqueFileName(filePath: string): string {
		const dotIndex = filePath.lastIndexOf(".");
		const base = dotIndex === -1 ? filePath : filePath.slice(0, dotIndex);
		const extension = dotIndex === -1 ? "" : filePath.slice(dotIndex);

		let candidate = filePath;
		let counter = 2;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${base} ${counter}${extension}`;
			counter += 1;
		}
		return candidate;
	}
}

class ConfirmModal extends Modal {
	title: string;
	message: string;
	confirmText: string;
	resolver: ((value: boolean) => void) | undefined;

	constructor(app: App, title: string, message: string, confirmText: string) {
		super(app);
		this.title = title;
		this.message = message;
		this.confirmText = confirmText;
	}

	openAndWait(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.title });
		const messageEl = contentEl.createEl("p", { text: this.message });
		messageEl.style.whiteSpace = "pre-line";

		const buttonRow = contentEl.createDiv();
		buttonRow.style.display = "flex";
		buttonRow.style.gap = "8px";
		buttonRow.style.justifyContent = "flex-end";

		buttonRow.createEl("button", { text: "取消" }).addEventListener("click", () => {
			this.finish(false);
		});
		buttonRow.createEl("button", { text: this.confirmText, cls: "mod-cta" }).addEventListener("click", () => {
			this.finish(true);
		});
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(false, false);
	}

	finish(result: boolean, closeModal = true): void {
		const resolve = this.resolver;
		this.resolver = undefined;
		if (closeModal) {
			this.close();
		}
		resolve?.(result);
	}
}

class KnowledgeExtractorSettingTab extends PluginSettingTab {
	plugin: KnowledgeExtractorPlugin;

	constructor(app: App, plugin: KnowledgeExtractorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "🧠 知识提取助手设置" });

		let endpointText: TextComponent | null = null;
		let modelText: TextComponent | null = null;
		let providerDropdown: DropdownComponent | null = null;
		let modelPresetDropdown: DropdownComponent | null = null;

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("输入你的大模型 API Key")
			.addText((text) => {
				text.setPlaceholder("sk-...").setValue(maskApiKey(this.plugin.settings.apiKey));
				text.inputEl.addEventListener("focus", () => {
					text.setValue(this.plugin.settings.apiKey);
				});
				text.inputEl.addEventListener("blur", async () => {
					const value = text.getValue();
					if (value !== this.plugin.settings.apiKey) {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}
					text.setValue(maskApiKey(this.plugin.settings.apiKey));
				});
			});

		new Setting(containerEl)
			.setName("API 快速预设")
			.setDesc("可选。用于一键填入常见兼容服务；下面的 Endpoint 和模型名称仍然可以手动改。")
			.addDropdown((dropdown) => {
				providerDropdown = dropdown;
				for (const [key, preset] of Object.entries(API_PRESETS) as [ApiProviderKey, (typeof API_PRESETS)[ApiProviderKey]][]) {
					dropdown.addOption(key, preset.label);
				}
				dropdown.setValue(this.plugin.settings.apiProvider);
				dropdown.onChange(async (value) => {
					const provider = value as ApiProviderKey;
					this.plugin.settings.apiProvider = provider;
					const preset = API_PRESETS[provider];
					if (preset.endpoint) {
						this.plugin.settings.apiEndpoint = preset.endpoint;
						endpointText?.setValue(preset.endpoint);
					}
					if ("defaultModel" in preset && preset.defaultModel) {
						this.plugin.settings.modelName = preset.defaultModel;
						modelText?.setValue(preset.defaultModel);
						if (modelPresetDropdown) {
							modelPresetDropdown.setValue(
								MODEL_PRESETS.includes(preset.defaultModel as (typeof MODEL_PRESETS)[number])
									? preset.defaultModel
									: CUSTOM_PRESET,
							);
						}
					}
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("API Endpoint")
			.setDesc("最终以这里填写的完整地址为准。支持任意 OpenAI-compatible `/chat/completions` 地址。")
			.addText((text) => {
				endpointText = text;
				text
					.setPlaceholder("https://api.moonshot.cn/v1/chat/completions")
					.setValue(this.plugin.settings.apiEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.apiEndpoint = value;
						this.plugin.settings.apiProvider = this.plugin.inferApiProvider(value);
						providerDropdown?.setValue(this.plugin.settings.apiProvider);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("模型快速预设")
			.setDesc("可选。用于快速填入常见模型；你仍然可以在下方输入任何服务商自己的模型 ID。")
			.addDropdown((dropdown) => {
				modelPresetDropdown = dropdown;
				dropdown.addOption(CUSTOM_PRESET, "Custom");
				for (const model of MODEL_PRESETS) {
					dropdown.addOption(model, model);
				}
				dropdown.setValue(
					MODEL_PRESETS.includes(this.plugin.settings.modelName as (typeof MODEL_PRESETS)[number])
						? this.plugin.settings.modelName
						: CUSTOM_PRESET,
				);
				dropdown.onChange(async (value) => {
					if (value !== CUSTOM_PRESET) {
						this.plugin.settings.modelName = value;
						modelText?.setValue(value);
					}
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("模型名称")
			.setDesc("例如：gpt-4o-mini、deepseek-chat、moonshot-v1-8k。这里永远可以手动填写。")
			.addText((text) => {
				modelText = text;
				text.setValue(this.plugin.settings.modelName).onChange(async (value) => {
					this.plugin.settings.modelName = value;
					modelPresetDropdown?.setValue(
						MODEL_PRESETS.includes(value as (typeof MODEL_PRESETS)[number]) ? value : CUSTOM_PRESET,
					);
					await this.plugin.saveSettings();
				});
			});

		const helper = containerEl.createEl("p", {
			text: "自定义兼容服务的设置方法：把 API Endpoint 填成完整的 `/chat/completions` 地址，把模型名称填成该服务商要求的原始 model id。",
		});
		helper.style.marginTop = "0";

		const apiTestStatus = containerEl.createEl("p", {
			text: "点击下方按钮可测试当前 API 配置是否真的可用。",
		});
		apiTestStatus.style.marginTop = "0";
		apiTestStatus.style.fontSize = "0.9em";

		new Setting(containerEl)
			.setName("测试当前 API 配置")
			.setDesc("使用当前 API Key、Endpoint 和模型名发起一个最小请求，验证它们是否生效。")
			.addButton((button: ButtonComponent) => {
				button.setButtonText("开始测试").onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("测试中...");
					apiTestStatus.textContent = "正在发送测试请求...";

					const result = await this.plugin.testApiConfiguration();
					apiTestStatus.textContent = result.message;
					apiTestStatus.style.color = result.ok ? "var(--text-success)" : "var(--text-error)";
					new Notice(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`, NOTICE_DURATION);

					button.setDisabled(false);
					button.setButtonText("重新测试");
				});
			});

		new Setting(containerEl)
			.setName("切片最大长度")
			.setDesc(`控制单个切片的最大字符数，建议不低于 ${MIN_CHUNK_LENGTH}。`)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.chunkMaxLength))
					.setValue(String(this.plugin.settings.chunkMaxLength))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.chunkMaxLength = Number.isFinite(parsed) && parsed >= MIN_CHUNK_LENGTH
							? parsed
							: DEFAULT_SETTINGS.chunkMaxLength;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("卡片输出目录")
			.setDesc("提取出的知识卡片会保存到这个 Vault 目录。留空则保存到根目录。")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.outputFolderPath)
					.setValue(this.plugin.settings.outputFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.outputFolderPath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Prompt目录路径")
			.setDesc("Vault 内模板根目录。插件会读取其中的 Chinese/English 子目录，并按输入语言自动选择对应模板。")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.promptDirectoryPath)
					.setValue(this.plugin.settings.promptDirectoryPath)
					.onChange(async (value) => {
						this.plugin.settings.promptDirectoryPath = value.trim();
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		const typeSection = containerEl.createDiv();
		void this.renderExtractionTypeSettings(typeSection);
	}

	async renderExtractionTypeSettings(containerEl: HTMLElement): Promise<void> {
		containerEl.empty();
		containerEl.createEl("h3", { text: "提取类型" });
		const hint = containerEl.createEl("p", {
			text: "Overview 会始终保留。默认五类会优先显示；模板目录里新增的其他 .md 片段也会自动出现在下面。",
		});
		hint.style.marginTop = "0";

		const availableTypes = await this.plugin.getAvailableExtractionTypes();
		if (availableTypes.length === 0) {
			containerEl.createEl("p", { text: "当前未检测到可选分类，将先使用默认类型。" });
			return;
		}

		for (const type of availableTypes) {
			new Setting(containerEl)
				.setName(type)
				.setDesc(EXTRACTION_TYPE_DESCRIPTIONS[type] ?? `启用后提取 ${type} 分类。`)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.enabledExtractionTypes.some((item) => normalizeTypeKey(item) === normalizeTypeKey(type)))
						.onChange(async (enabled) => {
							const currentTypes = new Map(
								sanitizeEnabledExtractionTypes(this.plugin.settings.enabledExtractionTypes).map((item) => [normalizeTypeKey(item), item]),
							);
							if (enabled) {
								currentTypes.set(normalizeTypeKey(type), type);
							} else {
								currentTypes.delete(normalizeTypeKey(type));
							}
							this.plugin.settings.enabledExtractionTypes = sortExtractionTypes(currentTypes.values());
							await this.plugin.saveSettings();
						}),
				);
		}
	}
}

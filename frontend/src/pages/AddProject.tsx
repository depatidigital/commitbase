import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { getProject } from "@/lib/projects";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Globe,
  ArrowLeft,
  GitBranch,
  CheckCircle,
  AlertCircle,
  Github,
  Gitlab,
  Lock,
  Search,
  Upload,
  FileCode,
  Server,
  Code2,
  Check,
  ChevronsUpDown,
  FolderGit2,
  Layers,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useCreateApplication } from "@/hooks/useApplications";
import { SourcePicker } from "@/components/SourcePicker";
import { getOrganizationsPage } from "@/lib/organizations";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { PageLayout } from "@/components/PageLayout";
import {
  CreateApplicationData,
  DetectedApp,
  DetectedProject,
  detectApps,
  detectProject,
  readDetectFiles,
  uploadApplicationSource,
  listRepositoryBranches,
  type UploadEntry,
} from "@/lib/applications";
import { getGithubAuthUrl, getGitlabAuthUrl, listGitRepositories, type GitRepositoryListing } from "@/lib/git";
import { t } from "@/lib/i18n";
import { isSuperAdmin } from "@/lib/auth";
import { getServers } from "@/lib/servers";

const PENDING_REPOSITORY = "addApp.pendingRepository";

/** A DNS-safe label: `My Shop_v2` → `my-shop-v2`. */
const slugify = (value?: string | null) =>
  (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

// what the backend accepts as a repository (projectDetect.ts REPOSITORY_URL)
const REPOSITORY_URL = /^(https?:\/\/|git@|ssh:\/\/)[^\s'"]+$/;
// Radix Select has no empty value: the repository root, in the folder picker
const ROOT_FOLDER = "__root__";

/**
 * A new project — its name and where its code comes from; its first app's type
 * is detected (asked only when it cannot be) — or (/project/:id/add-app) one
 * more app in a project. Created first: hosts and env are added on its page,
 * then it is deployed.
 */
export default function AddProject() {
  const navigate = useNavigate();
  // ?project=<id>: a new app in an existing project — its code is the
  // project's, so there is no source to pick, only the app's folder in it
  const { id: projectId = null } = useParams();
  const { data: joining, error: joiningError } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId!),
    enabled: !!projectId,
  });
  // the app's folder in the repository (monorepos); empty = the root
  const [rootDirectory, setRootDirectory] = useState("");
  // COMPOSE: which compose file(s) — a repository can ship several (CKAN: with and without its database)
  const [composeFile, setComposeFile] = useState("");
  const { toast } = useToast();
  const createApp = useCreateApplication();
  // Created first, deployed later: its hosts and its env are added on its page.
  // two is enough to know whether there is a choice of org to make
  const { data: myOrgs } = useQuery({
    queryKey: ["organizations", "mine"],
    queryFn: () => getOrganizationsPage({ page: 1, limit: 2, search: "" }),
  });
  const [organizationId, setOrganizationId] = useState("");

  const [formData, setFormData] = useState({
    name: "",
    type: "",
    repository: "",
    branch: "main",
  });
  // Which node the app runs on. Only a superadmin picks; "" = the org's default server.
  const superadmin = isSuperAdmin();
  const [serverId, setServerId] = useState("");
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: getServers, enabled: superadmin });
  // a stack needs a node with a container runtime: preselect one, unless one was picked already
  useEffect(() => {
    const picked = servers.find((s) => s.id === serverId);
    if (formData.type !== "COMPOSE" || (picked && picked.containerRuntime !== "NONE")) return;
    const node = servers.find((s) => s.containerRuntime !== "NONE" && s.status === "ONLINE") ?? servers.find((s) => s.containerRuntime !== "NONE");
    if (node) setServerId(node.id);
  }, [formData.type, servers, serverId]);
  // what Create is doing after the click: creating, the picked files going up, the first deploy starting
  const [busy, setBusy] = useState<"" | "uploading" | "deploying">("");
  const [sourceMode, setSourceMode] = useState<"git" | "upload">("git");
  // everything picked, and the paths unticked in the preview; what detection
  // and the upload see is the difference
  const [pickedFiles, setPickedFiles] = useState<UploadEntry[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const uploadFiles = useMemo(
    () => pickedFiles.filter(({ path }) => !excluded.has(path)),
    [pickedFiles, excluded],
  );
  const setUploadFiles = (entries: UploadEntry[]) => {
    setPickedFiles(entries);
    setExcluded(new Set());
  };
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  // every repo the connected accounts can see — cmdk searches the list locally
  const repoListing = useQuery({
    queryKey: ["git", "repositories"],
    queryFn: listGitRepositories,
    enabled: sourceMode === "git",
    // the backend answers from its own cache; five minutes keeps the picker instant across pages
    staleTime: 5 * 60_000,
  });
  const repoGroups = useMemo(() => {
    const groups = new Map<string, { key: string; heading: string; repositories: GitRepositoryListing["repositories"] }>();
    for (const repo of repoListing.data?.repositories ?? []) {
      const group = groups.get(repo.accountId) ?? {
        key: repo.accountId,
        heading: `${repo.provider === "github" ? "GitHub" : "GitLab"} · ${repo.account}`,
        repositories: [],
      };
      group.repositories.push(repo);
      groups.set(repo.accountId, group);
    }
    return [...groups.values()];
  }, [repoListing.data]);
  // the chosen repository, when it came from the list — shown by name, not URL
  const pickedRepo = repoListing.data?.repositories.find((repo) => repo.cloneUrl === formData.repository);
  const [detected, setDetected] = useState<DetectedProject | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState("");

  // the type shown as a confirmed chip until "Change"
  const [typeOpen, setTypeOpen] = useState(false);

  // A new project from a monorepo: every app found in the repository, as a
  // draft to tick. One app (or none found) keeps the single-app form.
  const [drafts, setDrafts] = useState<Array<DetectedApp & { name: string; checked: boolean }>>([]);
  const multi = drafts.length > 1;
  // the repository's folders, from the scan — the folder picker's options
  const [folders, setFolders] = useState<string[]>([]);
  useEffect(() => setFolders([]), [sourceMode, formData.repository, formData.branch]);
  const checkedDrafts = drafts.filter((d) => d.checked);
  const updateDraft = (index: number, change: Partial<(typeof drafts)[number]>) =>
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...change } : d)));

  // No host to decide the org: a new project is the caller's org's — only
  // someone with a choice of orgs (several, or a platform admin seeing all)
  // picks one. An app added to a project is the project's org's.
  const needsOrg = !projectId && (myOrgs?.pagination?.total ?? 0) > 1;
  // a new project is not asked its first app's type — detection's is used; asked only when it cannot tell
  const typeAsked = !multi && (!formData.type || !!detectError || detecting);

  // The source's own name — the repo, or the picked folder (loose files have
  // none worth using) — as a DNS-safe label.
  const sourceLabel = useMemo(
    () =>
      slugify(
        projectId
          ? rootDirectory.split("/").filter(Boolean).pop() || joining?.name
          : sourceMode === "git"
          ? rootDirectory.split("/").filter(Boolean).pop() || formData.repository.split(/[/:]/).pop()?.replace(/\.git$/, "")
          : uploadFiles[0]?.path.includes("/")
            ? uploadFiles[0].path.split("/")[0]
            : undefined,
      ),
    [sourceMode, formData.repository, uploadFiles, projectId, rootDirectory, joining?.name],
  );

  // The name is the app's own label, not its address (as on Vercel, Netlify,
  // Fly): it comes from the source and stays when its hosts change. Loose files
  // have no source name, so it is typed.
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => {
    if (!nameTouched) setFormData((prev) => ({ ...prev, name: sourceLabel || "" }));
  }, [sourceLabel, nameTouched]);

  // A pasted URL: read its branches and switch to the default one (not every
  // repo uses "main"). null = not read, which leaves the branch as free text.
  const [remoteBranches, setRemoteBranches] = useState<string[] | null>(null);
  const [remoteDefault, setRemoteDefault] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState("");
  // A private repo is read — and later cloned — through whichever of the
  // user's connected accounts can see it; the backend finds that account.
  const [manualAccountId, setManualAccountId] = useState<string | null>(null);
  const [needsAccount, setNeedsAccount] = useState<{ provider: "github" | "gitlab"; tried: number } | null>(null);
  const gitSource = sourceMode === "git";
  useEffect(() => {
    setRemoteBranches(null);
    setBranchesError("");
    setManualAccountId(null);
    setNeedsAccount(null);
    const url = formData.repository.trim();
    if (!gitSource || !url) return;

    let cancelled = false;
    // shorter than detection's 800ms, so detection sees the lookup start and waits
    const timer = setTimeout(async () => {
      setBranchesLoading(true);
      try {
        const { defaultBranch, branches, gitAccountId, needsAccount, triedAccounts } =
          await listRepositoryBranches(url);
        if (cancelled) return;
        if (needsAccount) {
          setNeedsAccount({ provider: needsAccount, tried: triedAccounts ?? 0 });
          return;
        }
        setManualAccountId(gitAccountId);
        setRemoteBranches(branches);
        setRemoteDefault(defaultBranch);
        setFormData((prev) => ({
          ...prev,
          branch: defaultBranch || branches[0] || prev.branch,
        }));
      } catch (error) {
        if (!cancelled)
          setBranchesError(error instanceof Error ? error.message : "");
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setBranchesLoading(false);
    };
  }, [gitSource, formData.repository]);

  // The folder picker's options come with the root scan, which is skipped once
  // a folder is set — a folder kept across a repository or branch change still gets its list.
  const hasFolder = !!rootDirectory.trim();
  const needFolders = !projectId && gitSource && hasFolder && !folders.length && !branchesLoading && !!remoteBranches?.length;
  useEffect(() => {
    if (!needFolders) return;
    let cancelled = false;
    detectApps({ repository: formData.repository.trim(), branch: formData.branch || "main", gitAccountId: manualAccountId || undefined })
      .then((scan) => !cancelled && setFolders(scan.folders ?? []))
      .catch(() => {}); // the typed folder still works without the list
    return () => {
      cancelled = true;
    };
  }, [needFolders, formData.repository, formData.branch, manualAccountId]);

  // Auto-detect the framework from the source (Vercel-style) and prefill the
  // build settings. Everything stays editable.
  useEffect(() => {
    const isGit = sourceMode === "git";
    // whatever another source (or folder) found no longer applies
    setDrafts([]);
    // wait for the branch lookup — detecting "main" on a "master" repo just fails
    if (isGit && !projectId && branchesLoading) return;
    // a repository nobody could read yet would only fail detection too
    const canDetect = projectId ? !!joining?.repository : isGit ? !!remoteBranches?.length : uploadFiles.length > 0;
    if (!canDetect) {
      setDetected(null);
      setDetectError("");
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setDetecting(true);
      setDetectError("");
      try {
        const folder = rootDirectory.trim() || undefined;
        const repository = { repository: formData.repository.trim(), branch: formData.branch || "main", gitAccountId: manualAccountId || undefined };
        // A new project's repository, no folder named: the root and every app in
        // it, in one clone — a monorepo's apps become drafts. Git only: a project
        // from an upload cannot have several apps.
        const scan = !projectId && isGit && !folder ? await detectApps(repository) : null;
        const result = scan
          ? scan.root
          : projectId
          ? await detectProject({ sourceId: projectId, rootDirectory: folder })
          : isGit
          ? await detectProject({ ...repository, rootDirectory: folder })
          : await detectProject({ files: await readDetectFiles(uploadFiles) });
        if (cancelled) return;
        if (scan) {
          const repoName = formData.repository.split(/[/:]/).pop()?.replace(/\.git$/, "");
          // ticked: what is plainly an app (a framework); libraries and bare HTML folders (docs) are left to the user
          const next = scan.apps.map((app) => ({
            ...app,
            name: slugify(app.rootDirectory.split("/").pop() || repoName),
            checked: !["node", "html", null].includes(app.detected.framework),
          }));
          if (next.length && !next.some((d) => d.checked)) next[0].checked = true;
          setDrafts(next);
          setFolders(scan.folders ?? []);
        }
        setDetected(result);
        // the file detection found, relative to the folder — editable before creating
        setComposeFile(result.type === "COMPOSE" ? result.composeFile?.split("/").pop() || "docker-compose.yml" : "");
        setFormData((prev) => ({
          ...prev,
          // an unrecognised project leaves the type blank, so the user has
          // to pick one instead of deploying a wrong guess
          type: result.framework === null ? "" : result.type,
        }));
      } catch (error) {
        if (!cancelled) {
          setDetectError(
            error instanceof Error ? error.message : t("Detection failed"),
          );
          // whatever an earlier source detected no longer applies
          setFormData((prev) => ({ ...prev, type: "" }));
        }
      } finally {
        if (!cancelled) setDetecting(false);
      }
    }, isGit || projectId ? 800 : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sourceMode, formData.repository, formData.branch, uploadFiles, branchesLoading, manualAccountId, remoteBranches, projectId, joining?.repository, rootDirectory]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Enter in a half-filled form must not fire the deploy
    if (!stepComplete(1) || !stepComplete(2)) return;

    // Created first, deployed later: build commands are detection's defaults,
    // and its hosts and env are added on its page before the first deploy.
    const applicationData: CreateApplicationData = {
      name: formData.name,
      type: formData.type as CreateApplicationData["type"],
      rootDirectory: rootDirectory.trim() || undefined,
      sourceId: projectId || undefined,
      repository:
        !projectId && sourceMode === "git" ? formData.repository || undefined : undefined,
      // Which connected account clones it: the one the branch lookup found
      // can read this repo. None for a public repo or an upload.
      gitAccountId: (!projectId && sourceMode === "git" && manualAccountId) || undefined,
      branch: projectId ? undefined : formData.branch,
      // an app of a project runs on the project's server
      serverId: (!projectId && serverId) || undefined,
      // with one org there is nothing to pick — but say which, for an admin who is not its member
      organizationId: projectId ? undefined : organizationId || myOrgs?.data[0]?.id,
      // Prisma's migrations: the tables have to exist before the release goes live
      preDeployCommand: (formData.type !== "STATIC" && detected?.preDeployCommand) || undefined,
      ...(formData.type === "COMPOSE" &&
        composeFile.trim() && {
          composeFiles: composeFile.split(",").map((file) => file.trim()).filter(Boolean),
        }),
    };
    // a monorepo: the project with its first ticked app, then the rest added to it
    const [first, ...rest] = multi ? checkedDrafts : [];
    const fromDraft = (draft: (typeof drafts)[number]) => ({
      name: draft.name,
      type: draft.detected.type as CreateApplicationData["type"],
      rootDirectory: draft.rootDirectory || undefined,
      preDeployCommand: (draft.detected.type !== "STATIC" && draft.detected.preDeployCommand) || undefined,
    });

    let createdId: string;
    try {
      createdId = (
        await createApp.mutateAsync(first ? { ...applicationData, ...fromDraft(first), projectName: formData.name } : applicationData)
      ).id;
    } catch {
      return; // createApp reports its own failure
    }

    for (const draft of rest) {
      // the project's id is its first app's (Source shares it); a failure is toasted, the rest still go
      await createApp.mutateAsync({ ...fromDraft(draft), sourceId: createdId }).catch(() => {});
    }

    // Picked files are the app's source: they go up now (a static site's are
    // its files — served once it has a host; anything else waits for the first deploy).
    if (sourceMode === "upload" && uploadFiles.length > 0) {
      setBusy("uploading");
      try {
        await uploadApplicationSource(createdId, uploadFiles);
      } catch (error) {
        toast({
          variant: "destructive",
          title: t("Upload failed"),
          description: error instanceof Error ? error.message : "",
        });
      }
    }
    setBusy("");

    // the project's page takes it from here: each app's hosts and env, then the first deploy
    navigate(`/project/${projectId || createdId}`);
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const appTypeOptions = [
    {
      value: "STATIC",
      label: t("Static site"),
      description: t("HTML, CSS and JS files served from object storage."),
      icon: Globe,
    },
    {
      value: "PHP",
      label: "PHP",
      description: t("PHP application served by the platform runtime."),
      icon: FileCode,
    },
    {
      value: "NODEJS",
      label: "Node.js",
      description: t("Node app built and run as a service on the server."),
      icon: Server,
    },
    {
      value: "PYTHON",
      label: "Python",
      description: t("Python app run as a service, in a virtualenv of its own."),
      icon: Code2,
    },
    {
      value: "COMPOSE",
      label: t("Compose stack"),
      description: t("Containers the server brings up from the repository's compose file."),
      icon: Layers,
    },
  ];


  const stepComplete = (value: number) => {
    if (value === 1 && projectId) return !!joining?.repository;
    if (value === 1)
      return sourceMode === "upload"
        ? uploadFiles.length > 0
        : // read, public or through an account, and has a branch to deploy
          !!remoteBranches?.length;
    return (
      !!formData.name &&
      (!needsOrg || !!organizationId) &&
      !detecting &&
      (multi ? checkedDrafts.length > 0 && checkedDrafts.every((d) => d.name.trim()) : !!formData.type)
    );
  };

  // The OAuth round trip reloads the page; keep the pasted URL across it.
  const rememberRepository = () => {
    if (formData.repository.trim()) sessionStorage.setItem(PENDING_REPOSITORY, formData.repository.trim());
  };
  useEffect(() => {
    const pending = sessionStorage.getItem(PENDING_REPOSITORY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_REPOSITORY);
    setFormData((prev) => ({ ...prev, repository: pending }));
  }, []);

  const handleConnectGithub = async () => {
    rememberRepository();
    try {
      const url = await getGithubAuthUrl();
      window.location.href = url;
    } catch (error) {
      const message =
        error instanceof Error && error.message === "GitHub OAuth is not configured"
          ? t("GitHub OAuth is not configured. A superadmin can set it up under Integrations → GitHub & GitLab.")
          : t("Could not start GitHub OAuth flow.");
      toast({
        variant: "destructive",
        title: t("GitHub connection failed"),
        description: message,
      });
    }
  };

  const handleConnectGitlab = async () => {
    rememberRepository();
    try {
      const url = await getGitlabAuthUrl();
      window.location.href = url;
    } catch (error) {
      const message =
        error instanceof Error && error.message === "GitLab OAuth is not configured"
          ? t("GitLab OAuth is not configured. A superadmin can set it up under Integrations → GitHub & GitLab.")
          : t("Could not start GitLab OAuth flow.");
      toast({
        variant: "destructive",
        title: t("GitLab connection failed"),
        description: message,
      });
    }
  };

  return (
    <PageLayout
      backTo={projectId ? `/project/${projectId}` : "/"}
      // without ?project=, this makes a project: its source, and its first app
      title={joining ? t("Add an app to {name}", { name: joining.name }) : t("Add project")}
      description={
        projectId
          ? t("It is built from the project's repository with its other apps, and deployed with them.")
          : t("Point at the code — the type is detected. Its hosts and env are added once it exists, then it is deployed.")
      }
    >
      <form onSubmit={handleSubmit} className="space-y-8">
        {/* an app of an existing project: its code is known, only the folder is asked */}
        {projectId && (
          <Card className="bg-gradient-card border-border/50 shadow-elegant">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <FolderGit2 className="h-5 w-5 text-primary" />
                <span>{joining?.name ?? t("Project")}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {joiningError ? (
                <p className="text-sm text-destructive">{(joiningError as Error).message}</p>
              ) : joining && !joining.repository ? (
                <p className="text-sm text-destructive">{t("Only a project from a git repository can have several apps.")}</p>
              ) : (
                <p className="font-mono text-xs text-muted-foreground">
                  {joining?.repository} · {joining?.branch || "main"}
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="rootDirectory">{t("Folder in the repository")}</Label>
                <Input
                  id="rootDirectory"
                  placeholder="apps/api"
                  value={rootDirectory}
                  onChange={(e) => setRootDirectory(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("Where this app's code is, e.g. apps/api. Empty = the repository root.")}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* where the code comes from — the rest of the form opens once it is read */}
        {!projectId && sourceMode && (
          <>
            {/* a project is a name and where its code comes from — one card, no scrolling */}
            <Card className="bg-gradient-card border-border/50 shadow-elegant">
              <CardContent className="space-y-4 pt-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="name">
                      {t("Project name")} <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="name"
                      placeholder="my-project"
                      value={formData.name}
                      onChange={(e) => {
                        setNameTouched(true);
                        handleInputChange("name", e.target.value);
                      }}
                      required
                    />
                  </div>
                  {/* whose it is: no host decides it here — its hosts are added on its page */}
                  {needsOrg && (
                    <div className="space-y-1.5">
                      <Label>
                        {t("Organization")} <span className="text-red-500">*</span>
                      </Label>
                      <OrganizationCombobox
                        value={organizationId || null}
                        onChange={(id) => setOrganizationId(id ?? "")}
                        placeholder={t("Whose app is it?")}
                      />
                    </div>
                  )}
                </div>

                {/* where the code comes from: a repository, or files from this machine */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label>{t("Source")}</Label>
                  <div className="inline-flex rounded-md border border-border/60 p-0.5 text-sm">
                    {(
                      [
                        ["git", GitBranch, t("Git repository"), t("Clone from GitHub, GitLab, or any repository URL.")],
                        ["upload", Upload, t("Upload files or folder"), t("Send files straight from this machine. No repository needed.")],
                      ] as const
                    ).map(([mode, Icon, label, hint]) => (
                      <button
                        key={mode}
                        type="button"
                        title={hint}
                        aria-pressed={sourceMode === mode}
                        onClick={() => setSourceMode(mode)}
                        className={`flex items-center gap-1.5 rounded px-3 py-1 transition-colors ${
                          sourceMode === mode ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {sourceMode === "upload" && (
                  <div className="space-y-4">
                    <SourcePicker
                      picked={pickedFiles}
                      excluded={excluded}
                      onPick={setUploadFiles}
                      onExcludedChange={setExcluded}
                    />
                    {formData.type === "STATIC" && (
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "Static uploads go straight to object storage and are served from there — nothing is built.",
                        )}
                      </p>
                    )}
                  </div>
                )}

                {sourceMode === "git" && (
                  <>
                    <div className="space-y-1.5">
                      {/* one field: pick from the connected accounts, or paste any URL into its search */}
                      <Popover
                        open={repoOpen}
                        onOpenChange={(open) => {
                          setRepoOpen(open);
                          if (!open) setRepoSearch("");
                        }}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            id="repository"
                            type="button"
                            variant="outline"
                            role="combobox"
                            aria-expanded={repoOpen}
                            className="h-9 w-full justify-between bg-card px-3 font-normal"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              {pickedRepo ? (
                                pickedRepo.provider === "github" ? (
                                  <Github className="h-4 w-4 shrink-0" />
                                ) : (
                                  <Gitlab className="h-4 w-4 shrink-0" />
                                )
                              ) : (
                                <Search className="h-4 w-4 shrink-0 opacity-50" />
                              )}
                              <span className={`truncate ${formData.repository ? "" : "text-muted-foreground"}`}>
                                {pickedRepo?.fullName || formData.repository || t("Select a repository or paste a URL")}
                              </span>
                            </span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[--radix-popover-trigger-width] max-w-[calc(100vw-2rem)] p-0" align="start">
                          <Command>
                            <CommandInput
                              placeholder={t("Search your repositories, or paste a Git URL…")}
                              value={repoSearch}
                              onValueChange={setRepoSearch}
                            />
                            <CommandList>
                              {/* a pasted URL is always offered, whatever the list filter says */}
                              {REPOSITORY_URL.test(repoSearch.trim()) && (
                                <CommandGroup>
                                  <CommandItem
                                    forceMount
                                    value={`url:${repoSearch.trim()}`}
                                    onSelect={() => {
                                      handleInputChange("repository", repoSearch.trim());
                                      setRepoOpen(false);
                                      setRepoSearch("");
                                    }}
                                  >
                                    <GitBranch className="mr-2 h-4 w-4 shrink-0" />
                                    <span className="truncate">
                                      {t("Use this URL: {url}", { url: repoSearch.trim() })}
                                    </span>
                                  </CommandItem>
                                </CommandGroup>
                              )}
                              {repoListing.isLoading ? (
                                <p className="p-4 text-sm text-muted-foreground">{t("Loading repositories…")}</p>
                              ) : (
                                !REPOSITORY_URL.test(repoSearch.trim()) && (
                                  <CommandEmpty>
                                    {repoListing.data?.accounts.length
                                      ? t("No repositories found — paste the URL instead.")
                                      : t("No GitHub or GitLab account connected. Connect one below, or paste a public repository URL.")}
                                  </CommandEmpty>
                                )
                              )}
                              {repoGroups.map(({ key, heading, repositories }) => (
                                <CommandGroup key={key} heading={heading}>
                                  {repositories.map((repo) => (
                                    <CommandItem
                                      key={`${repo.accountId}:${repo.fullName}`}
                                      value={`${repo.fullName} ${repo.accountId}`}
                                      onSelect={() => {
                                        handleInputChange("repository", repo.cloneUrl);
                                        setRepoOpen(false);
                                        setRepoSearch("");
                                      }}
                                    >
                                      <Check
                                        className={`mr-2 h-4 w-4 shrink-0 ${
                                          formData.repository === repo.cloneUrl ? "opacity-100" : "opacity-0"
                                        }`}
                                      />
                                      <span className="flex-1 truncate">{repo.fullName}</span>
                                      {repo.private && <Lock className="ml-2 h-3 w-3 shrink-0 text-muted-foreground" />}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              ))}
                            </CommandList>
                          </Command>
                          {!!repoListing.data?.errors.length && (
                            <p className="border-t px-3 py-2 text-xs text-destructive">
                              {repoListing.data.errors.join(" · ")}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-1 border-t p-2">
                            <Button type="button" variant="ghost" size="sm" onClick={handleConnectGithub}>
                              <Github className="h-4 w-4 mr-2" />
                              {t("Connect GitHub")}
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={handleConnectGitlab}>
                              <Gitlab className="h-4 w-4 mr-2" />
                              {t("Connect GitLab")}
                            </Button>
                          </div>
                        </PopoverContent>
                      </Popover>
                      {branchesLoading ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="animate-spin rounded-full h-3 w-3 border-2 border-current border-t-transparent" />
                          {t("Checking the repository…")}
                        </p>
                      ) : branchesError ? (
                        <p className="flex items-center gap-1.5 text-xs text-destructive">
                          <AlertCircle className="h-3 w-3" />
                          {t("This repository cannot be read. Check the URL — a private repository has to be on GitHub or GitLab.")}
                        </p>
                      ) : manualAccountId ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Lock className="h-3 w-3" />
                          {t("Private repository — read and deployed through your connected account.")}
                        </p>
                      ) : null}
                    </div>

                    {needsAccount && (
                      <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
                        <p className="flex items-center gap-1.5 text-sm font-medium">
                          <Lock className="h-4 w-4" />
                          {t("Private repository")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {needsAccount.tried > 0
                            ? t("None of your connected {provider} accounts can read this repository. Connect an account that has access, or check the URL.", {
                                provider: needsAccount.provider === "github" ? "GitHub" : "GitLab",
                              })
                            : t("This repository is private or does not exist. Connect {provider} so it can be read and deployed.", {
                                provider: needsAccount.provider === "github" ? "GitHub" : "GitLab",
                              })}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={needsAccount.provider === "github" ? handleConnectGithub : handleConnectGitlab}
                        >
                          {needsAccount.provider === "github" ? (
                            <Github className="h-4 w-4 mr-2" />
                          ) : (
                            <Gitlab className="h-4 w-4 mr-2" />
                          )}
                          {needsAccount.provider === "github" ? t("Connect GitHub") : t("Connect GitLab")}
                        </Button>
                      </div>
                    )}

                    {/* only once the repository has been read — the branches come from it; beside it, the folder (monorepos) */}
                    {remoteBranches && (
                    <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="branch">{t("Branch")}</Label>
                      {remoteBranches.length > 0 ? (
                        <Select
                          value={formData.branch}
                          onValueChange={(value) =>
                            handleInputChange("branch", value)
                          }
                        >
                          <SelectTrigger id="branch">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {remoteBranches.map((branch) => (
                              <SelectItem key={branch} value={branch}>
                                {branch}
                                {branch === remoteDefault && (
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    {t("default")}
                                  </span>
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {t("This repository has no branches yet — push a commit first.")}
                        </p>
                      )}
                    </div>
                    {/* a monorepo: the first app is one folder of it — unless its apps were found, below */}
                    {remoteBranches.length > 0 && !multi && (
                      <div className="space-y-1.5">
                        <Label htmlFor="rootDirectory" title={t("Only for a monorepo: the folder this app is in, e.g. apps/web. More apps from the same repository are added on the project.")}>
                          {t("Folder in the repository")}
                        </Label>
                        {/* always a pick: the chosen folder stays an option while the list (re)loads */}
                        <Select value={rootDirectory || ROOT_FOLDER} onValueChange={(value) => setRootDirectory(value === ROOT_FOLDER ? "" : value)}>
                          <SelectTrigger id="rootDirectory">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={ROOT_FOLDER}>{t("(repository root)")}</SelectItem>
                            {(rootDirectory && !folders.includes(rootDirectory) ? [rootDirectory, ...folders] : folders).map((folder) => (
                              <SelectItem key={folder} value={folder} className="font-mono">
                                {folder}
                              </SelectItem>
                            ))}
                            {!folders.length && (detecting || needFolders) && (
                              <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("Loading folders…")}</p>
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* a monorepo's apps, found in it: each ticked one is created with the project */}
        {multi && stepComplete(1) && (
          <Card className="bg-gradient-card border-border/50 shadow-elegant">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("Apps detected")}</CardTitle>
              <p className="text-xs text-muted-foreground">
                {t("The ticked ones are created with the project. Each gets its hosts and env on its own page.")}
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {drafts.map((draft, index) => {
                const Icon = appTypeOptions.find((o) => o.value === draft.detected.type)?.icon ?? Server;
                return (
                  <div key={draft.rootDirectory} className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 px-3 py-2">
                    <Checkbox
                      checked={draft.checked}
                      onCheckedChange={(value) => updateDraft(index, { checked: value === true })}
                      aria-label={draft.rootDirectory || t("(repository root)")}
                    />
                    <Input
                      value={draft.name}
                      onChange={(e) => updateDraft(index, { name: e.target.value })}
                      disabled={!draft.checked}
                      aria-label={t("App Name")}
                      className="h-8 w-40"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {draft.rootDirectory || t("(repository root)")}
                    </span>
                    <Badge variant="secondary" className="gap-1 font-normal">
                      <Icon className="h-3 w-3" />
                      {draft.detected.label}
                    </Badge>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* a compose stack always shows: which compose file runs is its choice to make */}
        {stepComplete(1) && (projectId || typeAsked || superadmin || (!multi && formData.type === "COMPOSE")) && (
          <>
            {/* an app of a project: its name, then the type — next to what detection
                guessed, so a wrong guess is fixed where it is shown. A new project
                is not asked its type: detection's is used, asked only when it fails */}
            <Card className="bg-gradient-card border-border/50 shadow-elegant">
              <CardContent className="space-y-5 pt-6">
                {projectId && (
                <>
                <div className="space-y-2">
                  <Label htmlFor="name">
                    {t("App Name")} <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="name"
                    placeholder="my-app"
                    value={formData.name}
                    onChange={(e) => {
                      setNameTouched(true);
                      handleInputChange("name", e.target.value);
                    }}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    {projectId
                      ? t("Your label for the app, taken from its source. It stays when its hosts change.")
                      : t("Taken from its source — its first app starts with the same name. Both can be renamed later.")}
                  </p>
                </div>

                {/* whose it is: no host decides it here — its hosts are added on its page */}
                {needsOrg && (
                  <div className="space-y-2">
                    <Label>
                      {t("Organization")} <span className="text-red-500">*</span>
                    </Label>
                    <OrganizationCombobox
                      value={organizationId || null}
                      onChange={(id) => setOrganizationId(id ?? "")}
                      placeholder={t("Whose app is it?")}
                    />
                  </div>
                )}
                </>
                )}

                {(projectId || typeAsked || (!multi && (!!detected || detecting))) && (
                <div className="space-y-2">
                  {/* what detection found sits on the heading line */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Label>
                      {t("App type")} <span className="text-red-500">*</span>
                    </Label>
                    {detecting ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="animate-spin rounded-full h-3 w-3 border-2 border-current border-t-transparent" />
                        {t("Inspecting the project…")}
                      </span>
                    ) : detectError ? (
                      <span className="flex items-center gap-1.5 text-xs text-destructive">
                        <AlertCircle className="h-3.5 w-3.5" />
                        {t("{error} — fill the build settings by hand.", {
                          error: detectError,
                        })}
                      </span>
                    ) : detected ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <CheckCircle className="h-3.5 w-3.5 text-primary" />
                        {t("Detected: {label}", { label: detected.label })}
                        {/* a stack has no package manager of its own: the file it runs is the detail */}
                        {detected.type === "COMPOSE"
                          ? detected.composeFile && ` · ${detected.composeFile}`
                          : ` · ${detected.packageManager}`}
                        {detected.nodeVersion && ` · Node ${detected.nodeVersion}`}
                      </span>
                    ) : null}
                  </div>
                  {/* a confident detection is a fact to confirm, not a choice to make */}
                  {detected && formData.type && !typeOpen && !detecting ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {(() => {
                        const option = appTypeOptions.find((o) => o.value === formData.type);
                        const Icon = option?.icon ?? Server;
                        return (
                          <span className="flex items-center gap-2 rounded-md border border-primary bg-primary/5 px-3 py-1.5 font-medium text-primary">
                            <Icon className="h-4 w-4" />
                            {option?.label ?? formData.type}
                          </span>
                        );
                      })()}
                      <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setTypeOpen(true)}>
                        {t("Change")}
                      </Button>
                    </div>
                  ) : (
                  <div className="flex flex-wrap gap-2">
                    {appTypeOptions.map((option) => {
                      const Icon = option.icon;
                      const selected = formData.type === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={selected}
                          title={option.description}
                          onClick={() => handleInputChange("type", option.value)}
                          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                            selected
                              ? "border-primary bg-primary/5 font-medium text-primary"
                              : "border-border/60 hover:border-primary/40"
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  )}
                  {!formData.type && !detecting ? (
                    <p className="text-xs text-destructive">
                      {t("Could not tell what this project is — pick its type.")}
                    </p>
                  ) : detected && formData.type !== "COMPOSE" ? (
                    <p className="text-xs text-muted-foreground">
                      {t("Install:")} <code>{detected.installCommand}</code>
                      {detected.buildCommand && (
                        <> · {t("Build:")} <code>{detected.buildCommand}</code></>
                      )}
                      {detected.startCommand && (
                        <> · {t("Start:")} <code>{detected.startCommand}</code></>
                      )}
                      {formData.type !== "STATIC" && detected.preDeployCommand && (
                        <> · {t("Pre-deploy:")} <code>{detected.preDeployCommand}</code></>
                      )}
                    </p>
                  ) : null}
                  {/* a stack can ship several compose files: pick which one runs */}
                  {formData.type === "COMPOSE" && !detecting && (
                    <div className="space-y-1.5">
                      <Label htmlFor="composeFile">{t("Compose files")}</Label>
                      {detected?.composeFiles?.length ? (
                        // the ones detection found in the folder: pick, don't type
                        <Select value={composeFile} onValueChange={setComposeFile}>
                          <SelectTrigger id="composeFile" className="font-mono">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {detected.composeFiles.map((file) => (
                              <SelectItem key={file} value={file} className="font-mono">
                                {file}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          id="composeFile"
                          className="font-mono"
                          value={composeFile}
                          onChange={(e) => setComposeFile(e.target.value)}
                          placeholder="docker-compose.yml"
                        />
                      )}
                      <p className="text-xs text-muted-foreground">
                        {detected?.composeFiles && detected.composeFiles.length > 1
                          ? t("{n} compose files in this folder. Service, port and env files are set on the app's page.", { n: String(detected.composeFiles.length) })
                          : t("In the folder above; several, comma separated, override in order. Service, port and env files are set on the app's page.")}
                      </p>
                    </div>
                  )}
                </div>
                )}

                {/* the rare choices, out of the way: native details, no state */}
                {superadmin && (
                  <details className="border-t pt-5">
                    <summary className="cursor-pointer text-sm font-medium">{t("Advanced")}</summary>
                    <div className="mt-3 space-y-2">
                      <Label htmlFor="server">{t("Server")}</Label>
                      <Select value={serverId || "__default"} onValueChange={(v) => setServerId(v === "__default" ? "" : v)}>
                        <SelectTrigger id="server" className="max-w-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default">{t("Organization's default server")}</SelectItem>
                          {servers.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name} ({s.status})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {t("Fixed once the app exists. Build and start commands can be changed on the app's Settings tab.")}
                      </p>
                    </div>
                  </details>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <div className="flex items-center justify-between">
          <Button type="button" variant="outline" onClick={() => navigate("/")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("Cancel")}
          </Button>

            <div className="flex flex-wrap items-center justify-end gap-3">
            {/* what the click will do, next to the click */}
            {detecting ? (
              <span className="text-right text-xs text-muted-foreground">{t("Inspecting the project…")}</span>
            ) : (
              stepComplete(1) && stepComplete(2) && !createApp.isPending && !busy && (
                <span className="text-right text-xs text-muted-foreground">
                  {t("Created now — add its hosts and env on its page, then deploy.")}
                </span>
              )
            )}
            <Button
              type="submit"
              disabled={!stepComplete(1) || !stepComplete(2) || createApp.isPending || !!busy}
              className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300 min-w-[140px]"
            >
              {createApp.isPending || busy ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent mr-2" />
                  {busy === "uploading" ? t("Uploading…") : t("Creating…")}
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  {projectId ? t("Create app") : t("Create project")}
                </>
              )}
            </Button>
            </div>
        </div>
      </form>
    </PageLayout>
  );
}

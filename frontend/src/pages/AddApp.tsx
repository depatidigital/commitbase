import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Globe,
  ArrowLeft,
  GitBranch,
  Terminal,
  Zap,
  CheckCircle,
  AlertCircle,
  Github,
  Gitlab
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCreateApplication } from "@/hooks/useApplications";
import { useDomains } from "@/hooks/useDomains";
import { CreateApplicationData } from "@/lib/applications";
import { useGitProjects } from "@/hooks/useGitProjects";
import { useGitBranches } from "@/hooks/useGitBranches";
import { useGitAccounts } from "@/hooks/useGitAccounts";
import { getGithubAuthUrl, getGitlabAuthUrl, getGitConnectionStatus } from "@/lib/git";

// Function to slugify text (convert to URL-friendly format)
const slugify = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters except hyphens
    .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
};

// Radix Select forbids an empty-string item value, so "no filter" needs a sentinel.
const ALL_WORKSPACES = "__all__";

export default function AddApp() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const createApp = useCreateApplication();
  const { data: domains, isLoading: domainsLoading, error: domainsError } = useDomains();

  const [formData, setFormData] = useState({
    name: "",
    selectedDomain: "",
    subdomain: "",
    type: "",
    repository: "",
    branch: "main",
    buildCommand: "",
    startCommand: "",
    port: "",
    envVars: ""
  });
  const [repoSource, setRepoSource] = useState<'manual' | 'github' | 'gitlab'>('manual');
  const [selectedGithubAccountId, setSelectedGithubAccountId] = useState("");
  const [selectedGitlabAccountId, setSelectedGitlabAccountId] = useState("");
  const [selectedGithubRepoId, setSelectedGithubRepoId] = useState("");
  const [selectedGitlabRepoId, setSelectedGitlabRepoId] = useState("");
  const [selectedGithubWorkspace, setSelectedGithubWorkspace] = useState(ALL_WORKSPACES);
  const [selectedGitlabWorkspace, setSelectedGitlabWorkspace] = useState(ALL_WORKSPACES);

  useEffect(() => {
    if (formData.name && !formData.subdomain) {
      const sluggedName = slugify(formData.name);
      if (sluggedName) {
        setFormData(prev => ({ ...prev, subdomain: sluggedName }));
      }
    }
  }, [formData.name, formData.subdomain]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Construct full domain from selected domain and subdomain
    const fullDomain = formData.subdomain
      ? `${formData.subdomain}.${formData.selectedDomain}`
      : formData.selectedDomain;

    // Parse environment variables
    const envVars: Record<string, string> = {};
    if (formData.envVars) {
      formData.envVars.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          envVars[key.trim()] = valueParts.join('=').trim();
        }
      });
    }

    const applicationData: CreateApplicationData = {
      name: formData.name,
      domain: fullDomain,
      type: formData.type as CreateApplicationData["type"],
      repository: formData.repository || undefined,
      branch: formData.branch,
      buildCommand: formData.buildCommand || undefined,
      startCommand: formData.startCommand || undefined,
      port: formData.port ? parseInt(formData.port) : undefined,
      envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
    };

    try {
      await createApp.mutateAsync(applicationData);
      navigate("/");
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const appTypeOptions = [
    { value: "NODEJS", label: "Node.js Application", icon: "⚡" },
    { value: "STATIC", label: "Static Website", icon: "🌐" },
  ];

  const availableDomains = domains?.filter(domain => domain.status === 'ACTIVE') || [];
  const { data: githubAccounts } = useGitAccounts('github', repoSource === 'github');
  const { data: gitlabAccounts } = useGitAccounts('gitlab', repoSource === 'gitlab');
  const {
    data: githubProjects,
    isLoading: githubLoading,
    error: githubError,
  } = useGitProjects('github', repoSource === 'github' && !!selectedGithubAccountId, selectedGithubAccountId);
  const {
    data: gitlabProjects,
    isLoading: gitlabLoading,
    error: gitlabError,
  } = useGitProjects('gitlab', repoSource === 'gitlab' && !!selectedGitlabAccountId, selectedGitlabAccountId);

  const { data: gitStatus } = useQuery({
    queryKey: ["git", "connection-status"],
    queryFn: getGitConnectionStatus,
  });

  const githubConnected = gitStatus?.githubConnected ?? false;
  const gitlabConnected = gitStatus?.gitlabConnected ?? false;

  const githubWorkspaces =
    githubProjects && githubProjects.length > 0
      ? Array.from(
          new Set(
            githubProjects
              .map((repo) => repo.workspace)
              .filter((ws): ws is string => !!ws),
          ),
        )
      : [];

  const gitlabWorkspaces =
    gitlabProjects && gitlabProjects.length > 0
      ? Array.from(
          new Set(
            gitlabProjects
              .map((repo) => repo.workspace)
              .filter((ws): ws is string => !!ws),
          ),
        )
      : [];

  const filteredGithubProjects =
    githubProjects && githubProjects.length > 0
      ? githubProjects.filter((repo) =>
          selectedGithubWorkspace !== ALL_WORKSPACES
            ? repo.workspace === selectedGithubWorkspace
            : true,
        )
      : githubProjects;

  const filteredGitlabProjects =
    gitlabProjects && gitlabProjects.length > 0
      ? gitlabProjects.filter((repo) =>
          selectedGitlabWorkspace !== ALL_WORKSPACES
            ? repo.workspace === selectedGitlabWorkspace
            : true,
        )
      : gitlabProjects;

  const {
    data: githubBranches,
    isLoading: githubBranchesLoading,
    error: githubBranchesError,
  } = useGitBranches(
    'github',
    selectedGithubRepoId,
    repoSource === 'github' && !!selectedGithubRepoId && !!selectedGithubAccountId,
    selectedGithubAccountId,
  );

  const {
    data: gitlabBranches,
    isLoading: gitlabBranchesLoading,
    error: gitlabBranchesError,
  } = useGitBranches(
    'gitlab',
    selectedGitlabRepoId,
    repoSource === 'gitlab' && !!selectedGitlabRepoId && !!selectedGitlabAccountId,
    selectedGitlabAccountId,
  );

  const handleConnectGithub = async () => {
    try {
      const url = await getGithubAuthUrl();
      window.location.href = url;
    } catch (error: any) {
      const message =
        error?.message === 'GitHub OAuth is not configured'
          ? 'GitHub OAuth is not configured on the server. Please set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.'
          : 'Could not start GitHub OAuth flow.';
      toast({
        variant: "destructive",
        title: "GitHub connection failed",
        description: message,
      });
    }
  };

  const handleConnectGitlab = async () => {
    try {
      const url = await getGitlabAuthUrl();
      window.location.href = url;
    } catch (error: any) {
      const message =
        error?.message === 'GitLab OAuth is not configured'
          ? 'GitLab OAuth is not configured on the server. Please set GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET.'
          : 'Could not start GitLab OAuth flow.';
      toast({
        variant: "destructive",
        title: "GitLab connection failed",
        description: message,
      });
    }
  };

  if (domainsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-current border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading domains...</p>
        </div>
      </div>
    );
  }

  if (domainsError) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Error Loading Domains</h3>
          <p className="text-muted-foreground">Failed to load domains. Please try again.</p>
        </div>
      </div>
    );
  }

  if (availableDomains.length === 0) {
    return (
      <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
        <div className="flex items-center space-x-4">
          <Button
            variant="ghost"
            onClick={() => navigate("/")}
            className="hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Applications
          </Button>
        </div>

        <Card className="bg-gradient-card border-border/50">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Globe className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Active Domains</h3>
            <p className="text-muted-foreground text-center max-w-md mb-4">
              You need to have at least one active domain to deploy applications.
              Please add a domain first.
            </p>
            <Button
              onClick={() => navigate("/domains")}
              className="bg-gradient-primary"
            >
              <Globe className="h-4 w-4 mr-2" />
              Manage Domains
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center space-x-4">
        <Button
          variant="ghost"
          onClick={() => navigate("/")}
          className="hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Applications
        </Button>
        <div>
          <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Deploy New Application
          </h1>
          <p className="text-muted-foreground mt-1">
            Configure and deploy your application to the platform
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Basic Information */}
        <Card className="bg-gradient-card border-border/50 shadow-elegant">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Zap className="h-5 w-5 text-primary" />
              <span>Basic Information</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="name">
                  Application Name <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="name"
                  placeholder="my-awesome-app"
                  value={formData.name}
                  onChange={(e) => handleInputChange("name", e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="subdomain">
                  Domain Configuration <span className="text-red-500">*</span>
                </Label>
                <div className="space-y-3">
                  <div className="flex items-center space-x-2">
                    <Globe className="min-w-4 min-h-4 text-muted-foreground" />
                    <Input
                      id="subdomain"
                      placeholder="app"
                      value={formData.subdomain}
                      onChange={(e) => handleInputChange("subdomain", e.target.value)}
                    />
                    <span className="text-muted-foreground">.</span>
                    <Select
                      value={formData.selectedDomain}
                      onValueChange={(value) => handleInputChange("selectedDomain", value)}
                    >
                      <SelectTrigger id="domain-select">
                        <SelectValue placeholder="Select a domain" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableDomains.map((domain) => (
                          <SelectItem key={domain.id} value={domain.name}>
                            <div className="flex items-center space-x-2">
                              <CheckCircle className="h-4 w-4 text-green-500" />
                              <span>{domain.name}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {formData.selectedDomain && (
                    <div className="text-xs text-muted-foreground">
                      Full domain: <span className="font-mono">
                        {formData.subdomain}.{formData.selectedDomain}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="app-type">
                Application Type <span className="text-red-500">*</span>
              </Label>
              <Select
                value={formData.type}
                onValueChange={(value) => handleInputChange("type", value)}
              >
                <SelectTrigger id="app-type">
                  <SelectValue placeholder="Select application type" />
                </SelectTrigger>
                <SelectContent>
                  {appTypeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <div className="flex items-center space-x-2">
                        <span>{option.icon}</span>
                        <span>{option.label}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Repository Configuration */}
        <Card className="bg-gradient-card border-border/50 shadow-elegant">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <GitBranch className="h-5 w-5 text-primary" />
              <span>Repository Configuration</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={repoSource === 'manual' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setRepoSource('manual')}
                >
                  <GitBranch className="h-4 w-4 mr-2" />
                  Manual URL
                </Button>
                <Button
                  type="button"
                  variant={repoSource === 'github' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setRepoSource('github')}
                >
                  <Github className="h-4 w-4 mr-2" />
                  GitHub
                </Button>
                <Button
                  type="button"
                  variant={repoSource === 'gitlab' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setRepoSource('gitlab')}
                >
                  <Gitlab className="h-4 w-4 mr-2" />
                  GitLab
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={githubConnected ? "outline" : "secondary"}
                  className="text-xs"
                >
                  <Github className="h-3 w-3 mr-1" />
                  {githubConnected ? "GitHub connected" : "GitHub not connected"}
                </Badge>
                <Badge
                  variant={gitlabConnected ? "outline" : "secondary"}
                  className="text-xs"
                >
                  <Gitlab className="h-3 w-3 mr-1" />
                  {gitlabConnected ? "GitLab connected" : "GitLab not connected"}
                </Badge>
              </div>
            </div>

            {repoSource === 'manual' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="repository">Git Repository URL</Label>
                  <Input
                    id="repository"
                    placeholder="https://github.com/username/repo.git"
                    value={formData.repository}
                    onChange={(e) =>
                      handleInputChange("repository", e.target.value)
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="branch">Branch</Label>
                  <Input
                    id="branch"
                    placeholder="main"
                    value={formData.branch}
                    onChange={(e) =>
                      handleInputChange("branch", e.target.value)
                    }
                  />
                </div>
              </>
            )}

            {repoSource === 'github' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="github-account">GitHub account</Label>
                  {githubAccounts && githubAccounts.length > 0 ? (
                    <Select
                      value={selectedGithubAccountId}
                      onValueChange={(value) => {
                        setSelectedGithubAccountId(value);
                        setSelectedGithubRepoId("");
                        setSelectedGithubWorkspace("");
                        handleInputChange("repository", "");
                        handleInputChange("branch", "main");
                      }}
                    >
                      <SelectTrigger id="github-account">
                        <SelectValue placeholder="Select a GitHub account" />
                      </SelectTrigger>
                      <SelectContent>
                        {githubAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.displayName || account.username || account.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : githubConnected ? (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        No GitHub accounts connected.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleConnectGithub}
                      >
                        <Github className="h-4 w-4 mr-2" />
                        Connect GitHub
                      </Button>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      GitHub is not connected. Click the GitHub button above to connect and manage repositories.
                    </p>
                  )}
                </div>

                {githubProjects && githubProjects.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="github-workspace">GitHub workspace</Label>
                    <Select
                      value={selectedGithubWorkspace}
                      onValueChange={(value) => {
                        setSelectedGithubWorkspace(value);
                        setSelectedGithubRepoId("");
                        handleInputChange("repository", "");
                        handleInputChange("branch", "main");
                      }}
                    >
                      <SelectTrigger id="github-workspace">
                        <SelectValue placeholder="All workspaces" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_WORKSPACES}>All workspaces</SelectItem>
                        {githubWorkspaces.map((workspace) => (
                          <SelectItem key={workspace} value={workspace}>
                            {workspace}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="github-repo">Select GitHub repository</Label>
                  {githubLoading ? (
                    <p className="text-sm text-muted-foreground">
                      Loading GitHub repositories...
                    </p>
                  ) : !selectedGithubAccountId ? (
                    <p className="text-sm text-muted-foreground">
                      Select a GitHub account above to list its repositories.
                    </p>
                  ) : githubError ? (
                    <p className="text-sm text-destructive">
                      Failed to load GitHub repositories.
                    </p>
                  ) : filteredGithubProjects && filteredGithubProjects.length > 0 ? (
                    <Select
                      value={selectedGithubRepoId}
                      onValueChange={(value) => {
                        setSelectedGithubRepoId(value);
                        const repo = filteredGithubProjects.find(
                          (item) => item.id === value,
                        );
                        if (repo) {
                          handleInputChange("repository", repo.cloneUrl);
                        }
                      }}
                    >
                      <SelectTrigger id="github-repo">
                        <SelectValue placeholder="Select a GitHub repository" />
                      </SelectTrigger>
                      <SelectContent>
                        {filteredGithubProjects.map((repo) => (
                          <SelectItem key={repo.id} value={repo.id}>
                            <div className="flex flex-col">
                              <span className="font-medium">{repo.name}</span>
                              {repo.workspace && (
                                <span className="text-xs text-muted-foreground">
                                  {repo.workspace}
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        No GitHub repositories found or your GitHub account is not connected.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleConnectGithub}
                      >
                        <Github className="h-4 w-4 mr-2" />
                        Connect GitHub
                      </Button>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="github-branch">Branch</Label>
                  {githubBranchesLoading ? (
                    <p className="text-sm text-muted-foreground">
                      Loading branches...
                    </p>
                  ) : githubBranchesError ? (
                    <p className="text-sm text-destructive">
                      Failed to load GitHub branches.
                    </p>
                  ) : githubBranches && githubBranches.length > 0 ? (
                    <Select
                      value={formData.branch}
                      onValueChange={(value) =>
                        handleInputChange("branch", value)
                      }
                    >
                      <SelectTrigger id="github-branch">
                        <SelectValue placeholder="Select a branch" />
                      </SelectTrigger>
                      <SelectContent>
                        {githubBranches.map((branch) => (
                          <SelectItem key={branch.name} value={branch.name}>
                            {branch.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No branches found for this repository.
                    </p>
                  )}
                </div>
              </div>
            )}

            {repoSource === 'gitlab' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="gitlab-account">GitLab account</Label>
                  {gitlabAccounts && gitlabAccounts.length > 0 ? (
                    <Select
                      value={selectedGitlabAccountId}
                      onValueChange={(value) => {
                        setSelectedGitlabAccountId(value);
                        setSelectedGitlabRepoId("");
                        setSelectedGitlabWorkspace("");
                        handleInputChange("repository", "");
                        handleInputChange("branch", "main");
                      }}
                    >
                      <SelectTrigger id="gitlab-account">
                        <SelectValue placeholder="Select a GitLab account" />
                      </SelectTrigger>
                      <SelectContent>
                        {gitlabAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.displayName || account.username || account.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : gitlabConnected ? (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        No GitLab accounts connected.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleConnectGitlab}
                      >
                        <Gitlab className="h-4 w-4 mr-2" />
                        Connect GitLab
                      </Button>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      GitLab is not connected. Click the GitLab button above to connect and manage repositories.
                    </p>
                  )}
                </div>

                {gitlabProjects && gitlabProjects.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="gitlab-workspace">GitLab workspace</Label>
                    <Select
                      value={selectedGitlabWorkspace}
                      onValueChange={(value) => {
                        setSelectedGitlabWorkspace(value);
                        setSelectedGitlabRepoId("");
                        handleInputChange("repository", "");
                        handleInputChange("branch", "main");
                      }}
                    >
                      <SelectTrigger id="gitlab-workspace">
                        <SelectValue placeholder="All workspaces" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_WORKSPACES}>All workspaces</SelectItem>
                        {gitlabWorkspaces.map((workspace) => (
                          <SelectItem key={workspace} value={workspace}>
                            {workspace}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="gitlab-project">Select GitLab project</Label>
                  {gitlabLoading ? (
                    <p className="text-sm text-muted-foreground">
                      Loading GitLab projects...
                    </p>
                  ) : !selectedGitlabAccountId ? (
                    <p className="text-sm text-muted-foreground">
                      Select a GitLab account above to list its projects.
                    </p>
                  ) : gitlabError ? (
                    <p className="text-sm text-destructive">
                      Failed to load GitLab projects.
                    </p>
                  ) : filteredGitlabProjects && filteredGitlabProjects.length > 0 ? (
                    <Select
                      value={selectedGitlabRepoId}
                      onValueChange={(value) => {
                        setSelectedGitlabRepoId(value);
                        const repo = filteredGitlabProjects.find(
                          (item) => item.id === value,
                        );
                        if (repo) {
                          handleInputChange("repository", repo.cloneUrl);
                        }
                      }}
                    >
                      <SelectTrigger id="gitlab-project">
                        <SelectValue placeholder="Select a GitLab project" />
                      </SelectTrigger>
                      <SelectContent>
                        {filteredGitlabProjects.map((repo) => (
                          <SelectItem key={repo.id} value={repo.id}>
                            <div className="flex flex-col">
                              <span className="font-medium">{repo.name}</span>
                              {repo.workspace && (
                                <span className="text-xs text-muted-foreground">
                                  {repo.workspace}
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        No GitLab projects found or your GitLab account is not connected.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleConnectGitlab}
                      >
                        <Gitlab className="h-4 w-4 mr-2" />
                        Connect GitLab
                      </Button>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="gitlab-branch">Branch</Label>
                  {gitlabBranchesLoading ? (
                    <p className="text-sm text-muted-foreground">
                      Loading branches...
                    </p>
                  ) : gitlabBranchesError ? (
                    <p className="text-sm text-destructive">
                      Failed to load GitLab branches.
                    </p>
                  ) : gitlabBranches && gitlabBranches.length > 0 ? (
                    <Select
                      value={formData.branch}
                      onValueChange={(value) =>
                        handleInputChange("branch", value)
                      }
                    >
                      <SelectTrigger id="gitlab-branch">
                        <SelectValue placeholder="Select a branch" />
                      </SelectTrigger>
                      <SelectContent>
                        {gitlabBranches.map((branch) => (
                          <SelectItem key={branch.name} value={branch.name}>
                            {branch.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No branches found for this project.
                    </p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Build & Runtime Configuration */}
        <Card className="bg-gradient-card border-border/50 shadow-elegant">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Terminal className="h-5 w-5 text-primary" />
              <span>Build & Runtime Configuration</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="buildCommand">Build Command</Label>
                <Input
                  id="buildCommand"
                  placeholder={formData.type === "STATIC" ? "npm run build" : "npm install"}
                  value={formData.buildCommand}
                  onChange={(e) => handleInputChange("buildCommand", e.target.value)}
                />
              </div>

              {formData.type === "NODEJS" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="startCommand">Start Command</Label>
                    <Input
                      id="startCommand"
                      placeholder="npm start"
                      value={formData.startCommand}
                      onChange={(e) => handleInputChange("startCommand", e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="port">Port</Label>
                    <Input
                      id="port"
                      type="number"
                      placeholder="3000"
                      value={formData.port}
                      onChange={(e) => handleInputChange("port", e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="envVars">Environment Variables</Label>
              <Textarea
                id="envVars"
                placeholder="NODE_ENV=production&#10;API_URL=https://api.example.com"
                value={formData.envVars}
                onChange={(e) => handleInputChange("envVars", e.target.value)}
                rows={4}
              />
              <p className="text-xs text-muted-foreground">
                One variable per line in KEY=value format
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Deploy Button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            {formData.name && formData.selectedDomain && formData.type && (
              <Badge variant="outline" className="bg-success/10 text-success border-success/20">
                <CheckCircle className="h-3 w-3 mr-1" />
                Ready to Deploy
              </Badge>
            )}
          </div>

          <Button
            type="submit"
            disabled={!formData.name || !formData.selectedDomain || !formData.type || createApp.isPending}
            className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300 min-w-[140px]"
          >
            {createApp.isPending ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent mr-2" />
                Deploying...
              </>
            ) : (
              <>
                <Zap className="h-4 w-4 mr-2" />
                Deploy App
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

import { useState, useEffect } from "react";
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
  AlertCircle
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCreateApplication } from "@/hooks/useApplications";
import { useDomains } from "@/hooks/useDomains";
import { CreateApplicationData } from "@/lib/applications";

// Function to slugify text (convert to URL-friendly format)
const slugify = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters except hyphens
    .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
};

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

  // Auto-generate subdomain from application name
  useEffect(() => {
    if (formData.name && !formData.subdomain) {
      const sluggedName = slugify(formData.name);
      if (sluggedName) {
        setFormData(prev => ({ ...prev, subdomain: sluggedName }));
      }
    }
  }, [formData.name]);

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
      type: formData.type as any,
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
    { value: "PYTHON", label: "Python Application", icon: "🐍" },
    { value: "GO", label: "Go Application", icon: "🐹" },
    { value: "RUST", label: "Rust Application", icon: "🦀" },
    { value: "PHP", label: "PHP Application", icon: "🐘" },
    { value: "JAVA", label: "Java Application", icon: "☕" },
  ];

  const availableDomains = domains?.filter(domain => domain.status === 'ACTIVE') || [];

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
  // use Effect swhen form.name change
  useEffect(() => {
    if (formData.name) {
      setFormData(prev => ({ ...prev, subdomain: slugify(formData.name) }));
    }
  }, [formData.name]);

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
                <Label>
                  Domain Configuration <span className="text-red-500">*</span>
                </Label>
                <div className="space-y-3">
                  <div className="flex items-center space-x-2">
                    <Globe className="min-w-4 min-h-4 text-muted-foreground" />
                    <Input
                      placeholder="app"
                      value={formData.subdomain}
                      onChange={(e) => handleInputChange("subdomain", e.target.value)}
                    />
                    <span className="text-muted-foreground">.</span>
                    <Select
                      value={formData.selectedDomain}
                      onValueChange={(value) => handleInputChange("selectedDomain", value)}
                    >
                      <SelectTrigger>
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
              <Label>
                Application Type <span className="text-red-500">*</span>
              </Label>
              <Select
                value={formData.type}
                onValueChange={(value) => handleInputChange("type", value)}
              >
                <SelectTrigger>
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
            <div className="space-y-2">
              <Label htmlFor="repository">Git Repository URL</Label>
              <Input
                id="repository"
                placeholder="https://github.com/username/repo.git"
                value={formData.repository}
                onChange={(e) => handleInputChange("repository", e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="branch">Branch</Label>
              <Input
                id="branch"
                placeholder="main"
                value={formData.branch}
                onChange={(e) => handleInputChange("branch", e.target.value)}
              />
            </div>
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
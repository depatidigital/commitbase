import { useState } from "react";
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
  CheckCircle
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function AddApp() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isDeploying, setIsDeploying] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    domain: "",
    type: "",
    repository: "",
    branch: "main",
    buildCommand: "",
    startCommand: "",
    port: "",
    envVars: ""
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsDeploying(true);

    // Simulate deployment process
    toast({
      title: "Deployment Started",
      description: "Your application is being deployed...",
    });

    // Simulate async deployment
    setTimeout(() => {
      setIsDeploying(false);
      toast({
        title: "Deployment Successful!",
        description: `${formData.name} has been deployed successfully.`,
      });
      navigate("/");
    }, 3000);
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const appTypeOptions = [
    { value: "nodejs", label: "Node.js Application", icon: "⚡" },
    { value: "static", label: "Static Website", icon: "🌐" }
  ];

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
          Back to Dashboard
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
                <Label htmlFor="name">Application Name</Label>
                <Input
                  id="name"
                  placeholder="my-awesome-app"
                  value={formData.name}
                  onChange={(e) => handleInputChange("name", e.target.value)}
                  required
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="domain">Domain</Label>
                <div className="flex items-center space-x-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <Input
                    id="domain"
                    placeholder="app.yourdomain.com"
                    value={formData.domain}
                    onChange={(e) => handleInputChange("domain", e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Application Type</Label>
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
                required
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
                  placeholder={formData.type === "static" ? "npm run build" : "npm install"}
                  value={formData.buildCommand}
                  onChange={(e) => handleInputChange("buildCommand", e.target.value)}
                />
              </div>

              {formData.type === "nodejs" && (
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
            {formData.name && formData.domain && formData.type && (
              <Badge variant="outline" className="bg-success/10 text-success border-success/20">
                <CheckCircle className="h-3 w-3 mr-1" />
                Ready to Deploy
              </Badge>
            )}
          </div>

          <Button 
            type="submit" 
            disabled={!formData.name || !formData.domain || !formData.type || isDeploying}
            className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300 min-w-[140px]"
          >
            {isDeploying ? (
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
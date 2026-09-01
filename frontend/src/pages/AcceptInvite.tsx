import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { acceptInvite, getInvitePreview } from "@/lib/organizations";
import { setAuthToken } from "@/lib/api";

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const token = params.get("token") || "";
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const {
    data: invite,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["invite", token],
    queryFn: () => getInvitePreview(token),
    enabled: !!token,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: () =>
      acceptInvite({
        token,
        name: name || undefined,
        password: password || undefined,
      }),
    onSuccess: (data) => {
      setAuthToken(data.token);
      toast({
        title: "Welcome",
        description: `You have joined ${invite?.organizationName ?? "the organization"}.`,
      });
      navigate("/");
    },
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  );

  if (!token) {
    return shell(
      <CardContent className="py-10 text-center">
        <AlertCircle className="mx-auto mb-4 h-10 w-10 text-destructive" />
        <p className="text-muted-foreground">
          This invite link is missing its token. Ask for a new invite.
        </p>
      </CardContent>
    );
  }

  if (isLoading) {
    return shell(
      <CardContent className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" />
      </CardContent>
    );
  }

  if (error || !invite) {
    return shell(
      <CardContent className="py-10 text-center">
        <AlertCircle className="mx-auto mb-4 h-10 w-10 text-destructive" />
        <p className="mb-4 text-muted-foreground">
          {(error as Error)?.message ||
            "This invite is invalid, already used, or expired."}
        </p>
        <Button variant="outline" onClick={() => navigate("/login")}>
          Go to sign in
        </Button>
      </CardContent>
    );
  }

  return shell(
    <>
      <CardHeader>
        <CardTitle>Join {invite.organizationName}</CardTitle>
        <CardDescription>
          Invited as <strong>{invite.email}</strong>{" "}
          <Badge variant="secondary">{invite.role}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {invite.needsPassword ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="name">Your name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Choose a password</Label>
              <Input
                id="password"
                type="password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            You already have a CommitBase account with this email — accepting adds
            you to {invite.organizationName}. Your password stays the same.
          </p>
        )}

        <Button
          className="w-full"
          onClick={() => mutation.mutate()}
          disabled={
            mutation.isPending || (invite.needsPassword && password.length < 8)
          }
        >
          {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Join organization
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          This invite expires {new Date(invite.expiresAt).toLocaleDateString()}.
        </p>
      </CardContent>
    </>
  );
}

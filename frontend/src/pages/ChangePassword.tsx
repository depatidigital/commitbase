import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { changePassword, mustChangePassword } from "@/lib/auth";

export default function ChangePassword() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const forced = mustChangePassword();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const mismatch = confirm.length > 0 && next !== confirm;

  const mutation = useMutation({
    mutationFn: () => changePassword(current, next),
    onSuccess: () => {
      toast({ title: "Password updated" });
      navigate("/");
    },
    onError: (error: Error) =>
      toast({ title: "Error", description: error.message, variant: "destructive" }),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Change your password</CardTitle>
          <CardDescription>
            {forced
              ? "Your account was created with a temporary password that an administrator also knows. Choose your own before continuing."
              : "Pick a new password for your account."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current">Current password</Label>
            <Input
              id="current"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="next">New password</Label>
            <Input
              id="next"
              type="password"
              placeholder="At least 8 characters"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm new password</Label>
            <Input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
            />
            {mismatch && (
              <p role="alert" className="text-sm text-destructive">
                Passwords do not match.
              </p>
            )}
          </div>

          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={
              mutation.isPending || !current || next.length < 8 || next !== confirm
            }
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Update password
          </Button>

          {!forced && (
            <Button variant="ghost" className="w-full" onClick={() => navigate(-1)}>
              Cancel
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

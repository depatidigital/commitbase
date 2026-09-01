import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, Loader2, Plus, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  assignDomain,
  createUser,
  getAdminDomains,
  getUsers,
  unassignDomain,
  updateUser,
  AdminUser,
} from "@/lib/admin";
import { createOrganization, getOrganizations } from "@/lib/organizations";

const UNASSIGNED = "__none__";

export default function Admin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [orgName, setOrgName] = useState("");
  const [newUser, setNewUser] = useState({ email: "", name: "", password: "" });

  const onError = (error: Error) =>
    toast({ title: "Error", description: error.message, variant: "destructive" });

  const { data: organizations = [] } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
  });
  const { data: users = [] } = useQuery({ queryKey: ["admin", "users"], queryFn: getUsers });
  const { data: domains = [], isLoading: domainsLoading } = useQuery({
    queryKey: ["admin", "domains"],
    queryFn: getAdminDomains,
  });

  const orgMutation = useMutation({
    mutationFn: () => createOrganization({ name: orgName }),
    onSuccess: () => {
      setOrgName("");
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast({ title: "Organization created" });
    },
    onError,
  });

  const userMutation = useMutation({
    mutationFn: () => createUser({ ...newUser, role: "CLIENT" }),
    onSuccess: () => {
      setNewUser({ email: "", name: "", password: "" });
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({ title: "User created", description: "Invite them to an organization from the Team page." });
    },
    onError,
  });

  const toggleActive = useMutation({
    mutationFn: ({ user, isActive }: { user: AdminUser; isActive: boolean }) =>
      updateUser(user.id, { isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({ title: "User updated" });
    },
    onError,
  });

  const assignMutation = useMutation({
    mutationFn: ({ domainId, organizationId }: { domainId: string; organizationId: string }) =>
      organizationId === UNASSIGNED
        ? unassignDomain(domainId)
        : assignDomain(domainId, organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "domains"] });
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      toast({ title: "Domain ownership updated", description: "Its applications moved with it." });
    },
    onError,
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Platform administration
        </h1>
        <p className="text-sm text-muted-foreground">
          Organizations, client accounts, and which organization owns which domain.
        </p>
      </div>

      <Tabs defaultValue="domains">
        <TabsList>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="organizations">Organizations</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
        </TabsList>

        <TabsContent value="domains" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Domain ownership</CardTitle>
            </CardHeader>
            <CardContent>
              {domainsLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Domain</TableHead>
                      <TableHead>Apps</TableHead>
                      <TableHead>Owning organization</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {domains.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">{d.name}</TableCell>
                        <TableCell>{d._count.applications}</TableCell>
                        <TableCell>
                          <Select
                            value={d.organization?.id ?? UNASSIGNED}
                            onValueChange={(organizationId) =>
                              assignMutation.mutate({ domainId: d.id, organizationId })
                            }
                          >
                            <SelectTrigger className="w-64">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                              {organizations.map((o) => (
                                <SelectItem key={o.id} value={o.id}>
                                  {o.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="organizations" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Plus className="h-4 w-4" /> New organization
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="Client name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
              />
              <Button onClick={() => orgMutation.mutate()} disabled={!orgName || orgMutation.isPending}>
                {orgMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="h-4 w-4" /> Organizations
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead>Domains</TableHead>
                    <TableHead>Apps</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizations.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">{o.name}</TableCell>
                      <TableCell className="text-muted-foreground">{o.slug}</TableCell>
                      <TableCell>{o._count.members}</TableCell>
                      <TableCell>{o._count.domains}</TableCell>
                      <TableCell>{o._count.applications}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Plus className="h-4 w-4" /> New client account
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="email"
                placeholder="Email"
                value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
              />
              <Input
                placeholder="Name"
                value={newUser.name}
                onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
              />
              <Input
                type="password"
                placeholder="Temporary password (min 8)"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              />
              <Button
                onClick={() => userMutation.mutate()}
                disabled={!newUser.email || newUser.password.length < 8 || userMutation.isPending}
              >
                {userMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Users</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Platform role</TableHead>
                    <TableHead>Organizations</TableHead>
                    <TableHead>Active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="font-medium">{u.name || u.email}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.role === "ADMIN" ? "default" : "secondary"}>{u.role}</Badge>
                      </TableCell>
                      <TableCell className="space-x-1">
                        {u.memberships.length === 0 && (
                          <span className="text-xs text-muted-foreground">none</span>
                        )}
                        {u.memberships.map((m) => (
                          <Badge key={m.organization.id} variant="outline">
                            {m.organization.name} · {m.role}
                          </Badge>
                        ))}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={u.isActive}
                          onCheckedChange={(isActive) => toggleActive.mutate({ user: u, isActive })}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

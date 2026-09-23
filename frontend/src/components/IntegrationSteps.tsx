import type { ReactNode } from 'react';
import { BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

export type StepGroup = { title?: string; steps: ReactNode[] };

/** "How to set this up" button in an integration page header, opening the guide in a modal. */
export function IntegrationSteps({ groups }: { groups: StepGroup[] }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <BookOpen className="h-4 w-4 mr-2" />
          {t('How to set this up')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('How to set this up')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {groups.map((group, i) => (
            <div key={i} className="space-y-2">
              {group.title && <p className="font-medium">{group.title}</p>}
              <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
                {group.steps.map((step, j) => (
                  <li key={j}>{step}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Inline monospace for URLs, permission names, and field values in steps. */
export const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>
);

// ponytail: guides are module constants — fine because the language is fixed per page load (see lib/i18n.ts)
export const RDASH_GUIDE: StepGroup[] = [
  {
    steps: [
      t('Log in to your Rdash reseller dashboard and open its API settings.'),
      t('Copy the Reseller ID and the API key.'),
      t("If the API is restricted by IP, allow this server's public IP there."),
      <>
        {t('Click Edit in RDASH configuration below and paste both. Leave Base URL blank to use')}{' '}
        <Code>https://api.rdash.id/v1</Code>.
      </>,
      t('Save. The overview loads once the credentials work, and domain registration becomes available.'),
    ],
  },
];

export const CLOUDFLARE_GUIDE: StepGroup[] = [
  {
    title: t('API token (DNS and zones)'),
    steps: [
      <>
        {t('In the Cloudflare dashboard open')} <Code>My Profile → API Tokens → Create Token</Code>{' '}
        {t('and start from a Custom token.')}
      </>,
      <>
        {t('Add these permissions:')} <Code>Account · Account Settings · Read</Code>, <Code>Zone · Zone · Edit</Code>,{' '}
        <Code>Zone · DNS · Edit</Code>, <Code>Zone · SSL and Certificates · Read</Code>{' '}
        {t('and, for static sites on R2,')} <Code>Account · Workers R2 Storage · Edit</Code>.
      </>,
      <>
        {t('Resources: your account, and')} <Code>Zone Resources → All zones from an account</Code>.
      </>,
      t('Create the token and copy it — Cloudflare shows it only once.'),
      t('Click Edit in Cloudflare configuration below and paste the token. Leave API base blank for the public Cloudflare API.'),
    ],
  },
  {
    title: t('R2 storage (optional, for static sites)'),
    steps: [
      <>
        {t('In the Cloudflare dashboard open')} <Code>R2 → Create bucket</Code>.
      </>,
      <>
        {t('Open')} <Code>R2 → Manage API tokens → Create API token</Code>{' '}
        {t('with Object Read & Write, scoped to that bucket.')}
      </>,
      t('Copy the Access Key ID and Secret Access Key, and the Account ID from the R2 overview page.'),
      t('Click Edit in Cloudflare R2 storage below and fill them in. Public URL is the custom domain connected to the bucket; Root folder is the prefix every site is uploaded under.'),
      t('Save. The settings are checked against the bucket right away.'),
    ],
  },
];

export const GOOGLE_GUIDE: StepGroup[] = [
  {
    steps: [
      <>
        {t('Open')} <Code>console.cloud.google.com</Code> {t('and create or pick a project.')}
      </>,
      <>
        {t('In')} <Code>APIs & Services → Library</Code> {t('enable')} <Code>Site Verification API</Code>{' '}
        {t('and')} <Code>Google Search Console API</Code>.
      </>,
      <>
        {t('Open')} <Code>IAM & Admin → Service Accounts → Create service account</Code>.{' '}
        {t('It needs no project roles.')}
      </>,
      <>
        {t('Open the service account, then')} <Code>Keys → Add key → Create new key → JSON</Code>.{' '}
        {t('A key file downloads.')}
      </>,
      t('Click Edit below and paste the whole contents of the key file.'),
      t('Under Default owners, list the Google accounts (comma-separated) that should see every added domain in their Search Console.'),
      t('Save. The key is checked against Google right away.'),
    ],
  },
];

export const GIT_GUIDE: StepGroup[] = [
  {
    title: 'GitHub',
    steps: [
      <>
        {t('On GitHub open')} <Code>Settings → Developer settings → OAuth Apps → New OAuth App</Code>.{' '}
        {t('For a workspace, use the same menu under the workspace settings.')}
      </>,
      t("Homepage URL: this panel's address. Authorization callback URL: the GitHub callback URL shown below, exactly."),
      t('Register the app, then Generate a new client secret.'),
      t('Click Edit on GitHub below, paste the Client ID and the client secret, and save.'),
    ],
  },
  {
    title: 'GitLab',
    steps: [
      <>
        {t('On GitLab open')} <Code>Edit profile → Applications → Add new application</Code>.{' '}
        {t('On a self-hosted GitLab an admin can use Admin area → Applications for an instance-wide app.')}
      </>,
      <>
        {t('Redirect URI: the GitLab callback URL shown below, exactly. Keep Confidential checked. Scopes:')}{' '}
        <Code>read_api</Code>, <Code>read_repository</Code>.
      </>,
      t('Save the application and copy the Application ID and the Secret.'),
      <>
        {t('Click Edit on GitLab below: Application ID goes in Client ID, Secret in Client secret. For a self-hosted GitLab also set OAuth URL to')}{' '}
        <Code>https://git.example.com/oauth</Code> {t('and API URL to')} <Code>https://git.example.com/api/v4</Code>.
      </>,
      t('Save.'),
    ],
  },
  {
    steps: [t('Users can now connect their GitHub and GitLab accounts from Add app and pick repositories from them.')],
  },
];

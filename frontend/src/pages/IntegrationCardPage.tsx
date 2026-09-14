import type { ReactNode } from 'react';

/** An integration whose whole page is its settings card (Google, Git OAuth). */
const IntegrationCardPage = ({ title, description, children }: { title: string; description: string; children: ReactNode }) => (
  <div className="max-w-6xl mx-auto space-y-8 animate-fade-in">
    <div>
      <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">{title}</h1>
      <p className="text-muted-foreground mt-1">{description}</p>
    </div>
    {children}
  </div>
);

export default IntegrationCardPage;

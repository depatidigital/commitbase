import type { ReactNode } from 'react';
import { IntegrationSteps, StepGroup } from '@/components/IntegrationSteps';

/** An integration whose whole page is its settings card (Google, Git OAuth). */
const IntegrationCardPage = ({ title, description, guide, children }: { title: string; description: string; guide: StepGroup[]; children: ReactNode }) => (
  <div className="max-w-6xl mx-auto space-y-8 animate-fade-in">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">{title}</h1>
        <p className="text-muted-foreground mt-1">{description}</p>
      </div>
      <IntegrationSteps groups={guide} />
    </div>
    {children}
  </div>
);

export default IntegrationCardPage;

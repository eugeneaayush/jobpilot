import type { ReactElement } from "react";
import type { Metadata } from "next";
import { PersonalDashboard } from "@/components/features/personal/personal-dashboard";
import { PageHeader, PageShell } from "@/components/ui/layout";

export const metadata: Metadata = { title: "Personal" };

export default function PersonalPage(): ReactElement {
  return (
    <PageShell maxWidth="xl">
      <PageHeader
        eyebrow="Private"
        title="Personal recruiting"
        description="Your MBA internship, post-MBA full-time, and professional tracks. Previews run offline. Campaigns apply within the scope you explicitly launch."
      />
      <PersonalDashboard />
    </PageShell>
  );
}

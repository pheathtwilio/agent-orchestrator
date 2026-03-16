import type { Metadata } from "next";
import { PlansDashboard } from "@/components/PlansDashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Plans | Agent Orchestrator",
};

export default function PlansPage() {
  return <PlansDashboard />;
}

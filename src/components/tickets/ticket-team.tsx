/**
 * A ticket's Jira team (FR-17.5, D59), read only: its name, linked to the team
 * in Context with the same name when there is one.
 */
import { Link } from "@tanstack/react-router";
import { useTeams } from "@/app/queries";
import { teamNamed } from "@/services/directory/team-name";

export function TicketTeam({ name }: { name: string }) {
  const teams = useTeams();
  const team = teamNamed(teams.data ?? [], name);
  if (!team) return <>{name}</>;
  return (
    <Link to="/context" search={{ tab: "teams", id: team.id }} className="underline">
      {name}
    </Link>
  );
}

declare module "jira2md" {
  const j2m: {
    to_jira(markdown: string): string;
    to_markdown(wiki: string): string;
    md_to_html(markdown: string): string;
    jira_to_html(wiki: string): string;
  };
  export default j2m;
}

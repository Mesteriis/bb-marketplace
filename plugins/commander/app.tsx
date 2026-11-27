import { definePluginApp } from "@get-bb/plugin-sdk/app";

function CommanderPage() {
  return <p>Commander — в разработке</p>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "commander",
    path: "commander",
    title: "Commander",
    icon: "Folders",
    component: CommanderPage,
  });
});

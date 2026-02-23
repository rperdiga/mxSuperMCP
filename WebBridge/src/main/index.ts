import { IComponent, getStudioProApi } from "@mendix/extensions-api";

export const component: IComponent = {
    async loaded(componentContext) {
        const studioPro = getStudioProApi(componentContext);

        // Register a dockable pane for the bridge
        const paneHandle = await studioPro.ui.panes.register(
            {
                title: "MCP Web Bridge",
                initialPosition: "right"
            },
            {
                componentName: "extension/web-bridge",
                uiEntrypoint: "tab",
            }
        );

        // Add menu item for manual open
        await studioPro.ui.extensionsMenu.add({
            menuId: "web-bridge.ShowPane",
            caption: "Show MCP Web Bridge",
            action: async () => {
                await studioPro.ui.panes.open(paneHandle);
            }
        });

        // Auto-open the pane so the bridge starts immediately
        await studioPro.ui.panes.open(paneHandle);
    }
};

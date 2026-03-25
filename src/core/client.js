class SDKClient {
    static instance;
    config = null;
    options;
    initialized = false;
    constructor() { }
    static getInstance() {
        if (!SDKClient.instance) {
            SDKClient.instance = new SDKClient();
        }
        return SDKClient.instance;
    }
    setOptions(options) {
        this.options = options;
    }
    setConfig(config) {
        this.config = config;
    }
    markInitialized() {
        this.initialized = true;
    }
}
export const client = SDKClient.getInstance();

export function parseStack(stack) {
    if (!stack)
        return [];
    return stack
        .split("\n")
        .slice(1)
        .map(line => line.trim())
        .filter(line => !line.includes("node_modules"))
        .map(line => {
        const match = line.match(/at (.+?) \((.+?):\d+:\d+\)/);
        if (!match)
            return null;
        return {
            function: match[1],
            file: match[2],
        };
    })
        .filter(Boolean);
}

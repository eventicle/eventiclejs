
export function pause(ms: number): Promise<void> {
    return new Promise((res => {
        setTimeout(args => {
            res()
        }, ms)
    }))
}

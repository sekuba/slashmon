export function explorer(chainId: number | undefined): string {
    return chainId === 11_155_111
        ? 'https://sepolia.etherscan.io'
        : 'https://etherscan.io';
}

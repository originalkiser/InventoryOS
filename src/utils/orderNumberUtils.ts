export function generateOrderNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `ORD-${date}-${rand}`
}

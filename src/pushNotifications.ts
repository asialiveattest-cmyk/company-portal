export async function getPushFunctionError(
  error: { message: string; context?: unknown } | null,
  fallback: string,
): Promise<string> {
  if (!error) return fallback;
  if (error.context instanceof Response) {
    try {
      const body: unknown = await error.context.clone().json();
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        return body.error;
      }
    } catch {
      return error.message || fallback;
    }
  }
  return error.message || fallback;
}

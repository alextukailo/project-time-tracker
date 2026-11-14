export function Spinner({ size = 'sm', className = '' }) {
  const dimension = size === 'md' ? 'h-5 w-5' : 'h-4 w-4';

  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none ${dimension} ${className}`}
    />
  );
}

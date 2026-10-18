import { Link } from 'react-router';

export function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">That {what} doesn’t exist</h1>
      <p className="mt-2 text-sm text-ink-2">It may have been deleted, or the link may be wrong. Your library is stored in this browser only, so a link from another device or browser won’t work.</p>
      <p className="mt-4">
        <Link to="/" className="font-medium text-accent underline underline-offset-2">
          Go to the dashboard
        </Link>
      </p>
    </div>
  );
}

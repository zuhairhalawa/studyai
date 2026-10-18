import { lazy } from 'react';
import { Route, Routes } from 'react-router';
import { SearchProvider } from './data';
import { Shell } from './Shell';
import { ToastProvider } from './toast';
import { CardsPage } from '@/pages/CardsPage';
import { CourseLayout } from '@/pages/CourseLayout';
import { CoursePage } from '@/pages/CoursePage';
import { Dashboard } from '@/pages/Dashboard';
import { NoteEditorPage } from '@/pages/NoteEditorPage';
import { PracticePage } from '@/pages/PracticePage';
import { NotesPage } from '@/pages/NotesPage';
import { NotFound } from '@/pages/NotFound';

// Heavy screens (KaTeX, zod, backup code) are loaded on demand.
const LecturePage = lazy(() => import('@/pages/LecturePage').then((m) => ({ default: m.LecturePage })));
const ReportPage = lazy(() => import('@/pages/ReportPage').then((m) => ({ default: m.ReportPage })));
const SearchPage = lazy(() => import('@/pages/SearchPage').then((m) => ({ default: m.SearchPage })));
const ExamPage = lazy(() => import('@/pages/ExamPage').then((m) => ({ default: m.ExamPage })));
const ExamResultsPage = lazy(() => import('@/pages/ExamResultsPage').then((m) => ({ default: m.ExamResultsPage })));
const ExamPaperPage = lazy(() => import('@/pages/ExamPaperPage').then((m) => ({ default: m.ExamPaperPage })));
const ReviewPage = lazy(() => import('@/pages/ReviewPage').then((m) => ({ default: m.ReviewPage })));
const TutorPage = lazy(() => import('@/pages/TutorPage').then((m) => ({ default: m.TutorPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

export function App() {
  return (
    <ToastProvider>
      <SearchProvider>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Dashboard />} />
            <Route path="course/:courseId" element={<CourseLayout />}>
              <Route index element={<CoursePage />} />
              <Route path="cards" element={<CardsPage />} />
              <Route path="notes" element={<NotesPage />} />
              <Route path="notes/:noteId" element={<NoteEditorPage />} />
              <Route path="practice" element={<PracticePage />} />
              <Route path="tutor" element={<TutorPage />} />
            </Route>
            <Route path="course/:courseId/review" element={<ReviewPage />} />
            <Route path="exam/:attemptId" element={<ExamPage />} />
            <Route path="exam/:attemptId/results" element={<ExamResultsPage />} />
            <Route path="exam/:examId/paper" element={<ExamPaperPage />} />
            <Route path="lecture/:lectureId" element={<LecturePage />} />
            <Route path="lecture/:lectureId/report" element={<ReportPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </SearchProvider>
    </ToastProvider>
  );
}

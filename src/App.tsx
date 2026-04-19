import React, { useState, useEffect, useMemo } from 'react';
import { 
  db, auth, googleProvider, signInWithPopup, onAuthStateChanged, User,
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, Timestamp, writeBatch, getDocFromServer, where, getDocs, limit
} from './firebase';
import { getDoc } from 'firebase/firestore';
import { GoogleGenAI } from "@google/genai";
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Send, ThumbsUp, Trash2, Eye, EyeOff, LogIn, LogOut, 
  AlertCircle, CheckCircle2, Loader2, Presentation, X,
  Plus, Users, ArrowLeft, LogIn as JoinIcon
} from 'lucide-react';
import { cn } from './lib/utils';
import { nanoid } from 'nanoid';

// --- Constants ---

// --- Types ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface Question {
  id: string;
  text: string;
  upvotes: number;
  createdAt: Timestamp;
  isSelected: boolean;
  authorId: string;
  classroomId: string;
  isAnswered?: boolean;
  answeredAt?: Timestamp;
  answeredBy?: string;
  answer?: string;
}

interface Classroom {
  id: string;
  roomCode: string;
  instructorId: string;
  createdAt: Timestamp;
  isActive: boolean;
}

// --- Socket Initialization ---
const socket: Socket = io();

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [isInstructor, setIsInstructor] = useState(false);
  const [showPresentation, setShowPresentation] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  
  // Classroom State
  const [currentClassroom, setCurrentClassroom] = useState<Classroom | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [questionToDelete, setQuestionToDelete] = useState<string | null>(null);
  const [questionToAnswer, setQuestionToAnswer] = useState<Question | null>(null);
  const [instructorAnswer, setInstructorAnswer] = useState('');
  const [isAnswering, setIsAnswering] = useState(false);

  // --- Auth & Initial Setup ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setAuthReady(true);
      
      if (u) {
        const idTokenResult = await u.getIdTokenResult();
        const hasInstructorRole = idTokenResult.claims.role === 'instructor';
        const isDefaultInstructor = u.email === "6831503045@lamduan.mfu.ac.th";
        setIsInstructor(hasInstructorRole || isDefaultInstructor);
      } else {
        setIsInstructor(false);
      }
    });

    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Firebase connection error: Client is offline.");
        }
        // Skip handleFirestoreError for the connection test as per instructions
      }
    };
    testConnection();

    return () => unsubscribe();
  }, []);

  // --- Real-time Questions (Filtered by Classroom) ---
  useEffect(() => {
    if (!authReady || !currentClassroom) {
      setQuestions([]);
      return;
    }

    const q = query(
      collection(db, 'questions'), 
      where('classroomId', '==', currentClassroom.id),
      orderBy('upvotes', 'desc'), 
      orderBy('createdAt', 'desc')
    );
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const qs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Question));
      setQuestions(qs);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'questions');
    });

    return () => unsubscribe();
  }, [authReady, currentClassroom]);

  // --- Socket Updates ---
  useEffect(() => {
    socket.on("selection_update", (id: string | null) => {
      setSelectedQuestionId(id);
    });
    return () => {
      socket.off("selection_update");
    };
  }, []);

  // --- Actions ---
  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed:", error);
    }
  };

  const handleLogout = () => {
    auth.signOut();
    setCurrentClassroom(null);
  };

  const handleCreateClassroom = async () => {
    if (!user || !isInstructor) return;
    setIsCreating(true);
    setError(null);
    
    try {
      const roomCode = nanoid(6).toUpperCase();
      const classroomId = nanoid();
      const classroomRef = doc(db, 'classrooms', classroomId);
      
      const newClassroom = {
        id: classroomId,
        roomCode,
        instructorId: user.uid,
        createdAt: Timestamp.now(),
        isActive: true
      };
      
      await setDoc(classroomRef, newClassroom);
      setCurrentClassroom(newClassroom);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'classrooms');
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinClassroom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim()) return;
    
    setIsJoining(true);
    setError(null);
    
    try {
      const trimmedCode = joinCode.trim().toUpperCase();
      const q = query(
        collection(db, 'classrooms'), 
        where('roomCode', '==', trimmedCode),
        limit(1)
      );
      
      const snapshot = await getDocs(q);
      if (snapshot.empty) {
        setError("Invalid room code.");
        setIsJoining(false);
        return;
      }
      
      const classroomData = snapshot.docs[0].data() as Classroom;
      if (!classroomData.isActive && trimmedCode !== "DEMO01") {
        setError("Classroom is no longer active.");
        setIsJoining(false);
        return;
      }
      
      setCurrentClassroom({ ...classroomData, id: snapshot.docs[0].id });
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'classrooms');
    } finally {
      setIsJoining(false);
    }
  };

  const handleCreateDemoRoom = async () => {
    if (!user) return;
    setIsJoining(true);
    setError(null);
    
    try {
      const demoRoomCode = "DEMO01";
      const q = query(
        collection(db, 'classrooms'), 
        where('roomCode', '==', demoRoomCode),
        limit(1)
      );
      
      const snapshot = await getDocs(q);
      let classroomData: Classroom;
      
      if (snapshot.empty) {
        // Create it
        const classroomId = nanoid();
        const classroomRef = doc(db, 'classrooms', classroomId);
        classroomData = {
          id: classroomId,
          roomCode: demoRoomCode,
          instructorId: user.uid,
          createdAt: Timestamp.now(),
          isActive: true
        };
        await setDoc(classroomRef, classroomData);
      } else {
        // Join existing
        const docData = snapshot.docs[0].data() as Classroom;
        classroomData = { ...docData, id: snapshot.docs[0].id };
      }
      
      setCurrentClassroom(classroomData);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'classrooms');
    } finally {
      setIsJoining(false);
    }
  };

  const handleUpvote = async (questionId: string) => {
    if (!user || (isInstructor && currentClassroom?.roomCode !== "DEMO01") || !currentClassroom) return;
    const voteId = `${user.uid}_${questionId}`;
    const voteRef = doc(db, 'votes', voteId);
    const questionRef = doc(db, 'questions', questionId);

    try {
      const batch = writeBatch(db);
      batch.set(voteRef, { userId: user.uid, questionId, classroomId: currentClassroom.id });
      batch.update(questionRef, { upvotes: questions.find(q => q.id === questionId)!.upvotes + 1 });
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'votes/questions');
    }
  };

  const handleSelectQuestion = (id: string | null) => {
    if (!isInstructor) return;
    socket.emit("select_question", id);
    if (id) {
      updateDoc(doc(db, 'questions', id), { isSelected: true });
    }
  };

  const handleDeleteQuestion = async () => {
    if (!questionToDelete) return;
    const question = questions.find(q => q.id === questionToDelete);
    if (!question) return;

    const canDelete = isInstructor || (user && question.authorId === user.uid);
    if (!canDelete) return;

    try {
      await deleteDoc(doc(db, 'questions', questionToDelete));
      setQuestionToDelete(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `questions/${questionToDelete}`);
    }
  };

  const handleAnswerQuestion = async (answer: string) => {
    if (!questionToAnswer || !user || !isInstructor) return;
    setIsAnswering(true);

    try {
      await updateDoc(doc(db, 'questions', questionToAnswer.id), {
        isAnswered: true,
        answeredAt: Timestamp.now(),
        answeredBy: user.uid,
        answer: answer
      });

      setQuestionToAnswer(null);
      setInstructorAnswer('');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `questions/${questionToAnswer.id}`);
    } finally {
      setIsAnswering(false);
    }
  };

  const activeQuestions = useMemo(() => 
    questions.filter(q => !q.isAnswered), 
    [questions]
  );

  const answeredQuestions = useMemo(() => 
    questions.filter(q => q.isAnswered).sort((a, b) => (b.answeredAt?.toMillis() || 0) - (a.answeredAt?.toMillis() || 0)), 
    [questions]
  );

  const selectedQuestion = useMemo(() => 
    questions.find(q => q.id === selectedQuestionId), 
    [questions, selectedQuestionId]
  );

  if (!authReady) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-neutral-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans selection:bg-neutral-200">
      {/* Header */}
      <header className="sticky top-0 z-40 w-full border-b border-neutral-200 bg-white/80 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setCurrentClassroom(null)}>
            <div className="w-8 h-8 bg-neutral-900 rounded-lg flex items-center justify-center text-white font-bold">A</div>
            <h1 className="text-xl font-semibold tracking-tight">AnonClass</h1>
          </div>
          
          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-3">
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-medium leading-none">{user.displayName}</p>
                  <p className="text-xs text-neutral-500">{isInstructor ? 'Instructor' : 'Student'}</p>
                </div>
                <button 
                  onClick={handleLogout}
                  className="p-2 hover:bg-neutral-100 rounded-full transition-colors"
                  title="Logout"
                >
                  <LogOut className="w-5 h-5 text-neutral-600" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <button 
                  onClick={handleLogin}
                  className="flex items-center gap-2 bg-neutral-900 text-white px-4 py-2 rounded-full text-sm font-medium hover:bg-neutral-800 transition-all active:scale-95"
                >
                  <LogIn className="w-4 h-4" />
                  Sign In
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        {!currentClassroom ? (
          <div className="max-w-md mx-auto space-y-8 py-12">
            <div className="text-center space-y-2">
              <h2 className="text-3xl font-bold tracking-tight">Welcome to AnonClass</h2>
              <p className="text-neutral-500">Join a classroom or create a new session.</p>
            </div>

            {user ? (
              <div className="space-y-6">
                {/* Join Classroom */}
                <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="flex items-center gap-2 text-neutral-700">
                    <JoinIcon className="w-5 h-5" />
                    <h3 className="font-semibold">Join a Classroom</h3>
                  </div>
                  <form onSubmit={handleJoinClassroom} className="space-y-3">
                    <input 
                      type="text"
                      value={joinCode}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                      placeholder="Enter Room Code (e.g. AB12CD)"
                      className="w-full p-4 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none transition-all font-mono text-center text-lg tracking-widest"
                      maxLength={6}
                    />
                    {error && (
                      <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-xs font-medium">
                        <AlertCircle className="w-4 h-4" />
                        {error}
                      </div>
                    )}
                    <button 
                      type="submit"
                      disabled={isJoining || joinCode.length < 4}
                      className="w-full bg-neutral-900 text-white py-3 rounded-xl font-medium hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400 transition-all flex items-center justify-center gap-2"
                    >
                      {isJoining ? <Loader2 className="w-4 h-4 animate-spin" /> : "Join Session"}
                    </button>
                    
                    <div className="relative py-2">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t border-neutral-200"></span>
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-white px-2 text-neutral-400">Or testing</span>
                      </div>
                    </div>

                    <button 
                      type="button"
                      onClick={handleCreateDemoRoom}
                      disabled={isJoining}
                      className="w-full bg-white border border-neutral-200 text-neutral-900 py-3 rounded-xl font-medium hover:bg-neutral-50 transition-all flex items-center justify-center gap-2"
                    >
                      <Presentation className="w-4 h-4 text-neutral-400" />
                      Create Demo Room
                    </button>
                  </form>
                </div>

                {/* Create Classroom (Instructors Only) */}
                {isInstructor && (
                  <div className="bg-neutral-900 text-white rounded-2xl p-6 shadow-xl space-y-4">
                    <div className="flex items-center gap-2">
                      <Plus className="w-5 h-5 text-neutral-400" />
                      <h3 className="font-semibold">Instructor Panel</h3>
                    </div>
                    <p className="text-sm text-neutral-400">Start a new classroom session to receive anonymous questions from your students.</p>
                    <button 
                      onClick={handleCreateClassroom}
                      disabled={isCreating}
                      className="w-full bg-white text-neutral-900 py-3 rounded-xl font-medium hover:bg-neutral-100 transition-all flex items-center justify-center gap-2"
                    >
                      {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create New Classroom"}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white border border-neutral-200 rounded-2xl p-8 text-center space-y-6">
                <div className="w-16 h-16 bg-neutral-100 rounded-full flex items-center justify-center mx-auto">
                  <Users className="w-8 h-8 text-neutral-400" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold">Sign in to get started</h3>
                  <p className="text-sm text-neutral-500">Sign in with your university account to join or create classrooms.</p>
                </div>
                <div className="space-y-4">
                  <button 
                    onClick={handleLogin}
                    className="w-full bg-neutral-900 text-white py-4 rounded-xl font-medium hover:bg-neutral-800 transition-all shadow-lg shadow-neutral-200"
                  >
                    Sign In with Google
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Left Column: Classroom Info & Submission */}
            <div className="lg:col-span-4 space-y-6">
              <div className="bg-white border border-neutral-200 rounded-2xl p-6 space-y-6 shadow-sm">
                <button 
                  onClick={() => setCurrentClassroom(null)}
                  className="flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Leave Classroom
                </button>
                
                <div className="space-y-4">
                  <div className="space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-400">Room Code</span>
                    <h2 className="text-4xl font-black tracking-tighter text-neutral-900">{currentClassroom.roomCode}</h2>
                  </div>
                  
                  <div className="p-4 bg-neutral-50 rounded-xl flex flex-col items-center gap-2">
                    <p className="text-xs text-neutral-500 text-center">Share this code with your students to join the session.</p>
                  </div>
                </div>
              </div>

              {/* Question Submission (Students OR Instructor in Demo Room) */}
              {!isInstructor || currentClassroom.roomCode === "DEMO01" ? (
                <div className="space-y-6">
                  <QuestionForm user={user!} classroomId={currentClassroom.id} />
                  
                  {answeredQuestions.length > 0 && (
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 text-neutral-500 px-2">
                        <CheckCircle2 className="w-4 h-4" />
                        <h3 className="text-sm font-bold uppercase tracking-widest">Answered Questions</h3>
                      </div>
                      <div className="space-y-4">
                        {answeredQuestions.map((q) => (
                          <QuestionCard 
                            key={q.id} 
                            question={q} 
                            onUpvote={() => handleUpvote(q.id)}
                            onSelect={() => handleSelectQuestion(q.id)}
                            onDelete={() => setQuestionToDelete(q.id)}
                            isSelected={false}
                            isInstructor={isInstructor}
                            currentUserId={user?.uid}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center space-y-2">
                    <AlertCircle className="w-6 h-6 text-amber-600 mx-auto" />
                    <h3 className="font-semibold text-amber-900">Instructor Mode</h3>
                    <p className="text-xs text-amber-700">You are managing this session. Instructors cannot submit questions.</p>
                  </div>

                  {answeredQuestions.length > 0 && (
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 text-neutral-500 px-2">
                        <CheckCircle2 className="w-4 h-4" />
                        <h3 className="text-sm font-bold uppercase tracking-widest">Answered Questions</h3>
                      </div>
                      <div className="space-y-4">
                        {answeredQuestions.map((q) => (
                          <QuestionCard 
                            key={q.id} 
                            question={q} 
                            onUpvote={() => handleUpvote(q.id)}
                            onSelect={() => handleSelectQuestion(q.id)}
                            onDelete={() => setQuestionToDelete(q.id)}
                            isSelected={false}
                            isInstructor={isInstructor}
                            currentUserId={user?.uid}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {isInstructor && (
                <div className="bg-neutral-900 text-white rounded-2xl p-6 space-y-4 shadow-xl shadow-neutral-200">
                  <div className="flex items-center gap-2">
                    <Presentation className="w-5 h-5 text-neutral-400" />
                    <h2 className="font-semibold">Instructor Controls</h2>
                  </div>
                  <p className="text-sm text-neutral-300">Select a question from the feed to display it in presentation mode.</p>
                  <button 
                    onClick={() => setShowPresentation(true)}
                    disabled={!selectedQuestionId}
                    className={cn(
                      "w-full py-3 rounded-xl font-medium transition-all flex items-center justify-center gap-2",
                      selectedQuestionId 
                        ? "bg-white text-neutral-900 hover:bg-neutral-100" 
                        : "bg-neutral-800 text-neutral-500 cursor-not-allowed"
                    )}
                  >
                    Open Presentation Mode
                  </button>
                </div>
              )}
            </div>

            {/* Right Column: Feed */}
            <div className="lg:col-span-8 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold tracking-tight">Question Feed</h2>
                <div className="text-sm text-neutral-500 bg-neutral-100 px-3 py-1 rounded-full">
                  {activeQuestions.length} Active Questions
                </div>
              </div>

              <div className="space-y-4">
                <AnimatePresence mode="popLayout">
                  {activeQuestions.map((q) => (
                    <QuestionCard 
                      key={q.id} 
                      question={q} 
                      onUpvote={() => handleUpvote(q.id)}
                      onSelect={() => handleSelectQuestion(q.id)}
                      onDelete={() => setQuestionToDelete(q.id)}
                      onAnswer={() => setQuestionToAnswer(q)}
                      isSelected={selectedQuestionId === q.id}
                      isInstructor={isInstructor}
                      currentUserId={user?.uid}
                    />
                  ))}
                </AnimatePresence>
                
                {activeQuestions.length === 0 && (
                  <div className="py-20 text-center space-y-2">
                    <p className="text-neutral-400 font-medium">No active questions.</p>
                    <p className="text-sm text-neutral-500">All caught up or waiting for new ones!</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Presentation Mode Modal */}
      <AnimatePresence>
        {showPresentation && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-neutral-900 flex flex-col items-center justify-center p-8 text-center"
          >
            <button 
              onClick={() => setShowPresentation(false)}
              className="absolute top-8 right-8 p-3 bg-neutral-800 text-white rounded-full hover:bg-neutral-700 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>

            <div className="max-w-4xl w-full space-y-12">
              <div className="space-y-4">
                <span className="text-neutral-500 font-mono tracking-widest uppercase text-sm">Now Presenting</span>
                <div className="h-1 w-24 bg-neutral-700 mx-auto rounded-full" />
              </div>

              {selectedQuestion ? (
                <motion.div
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  key={selectedQuestion.id}
                  className="space-y-8"
                >
                  <h2 className="text-4xl sm:text-6xl font-bold text-white leading-tight">
                    "{selectedQuestion.text}"
                  </h2>
                  <div className="flex items-center justify-center gap-4 text-neutral-400">
                    <div className="flex items-center gap-2">
                      <ThumbsUp className="w-6 h-6" />
                      <span className="text-2xl font-semibold">{selectedQuestion.upvotes}</span>
                    </div>
                    <div className="w-1.5 h-1.5 bg-neutral-700 rounded-full" />
                    <span className="text-xl">Anonymous Student</span>
                  </div>
                </motion.div>
              ) : (
                <div className="text-neutral-500 text-2xl">No question selected.</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Answer Question Modal */}
      <AnimatePresence>
        {questionToAnswer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isAnswering && setQuestionToAnswer(null)}
              className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl p-8 space-y-6"
            >
              <div className="space-y-4">
                <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6 text-green-600" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold tracking-tight text-neutral-900">
                    Answer Question
                  </h3>
                  <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-100">
                    <p className="text-sm text-neutral-600 italic">"{questionToAnswer.text}"</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-semibold text-neutral-700">Your Answer</label>
                  <textarea 
                    value={instructorAnswer}
                    onChange={(e) => setInstructorAnswer(e.target.value)}
                    placeholder="Provide a clear answer to this question..."
                    className="w-full min-h-[120px] p-4 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all resize-none text-sm"
                  />
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={() => setQuestionToAnswer(null)}
                  disabled={isAnswering}
                  className="flex-1 px-6 py-3 rounded-xl font-semibold text-neutral-600 bg-neutral-100 hover:bg-neutral-200 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleAnswerQuestion(instructorAnswer)}
                  disabled={isAnswering || !instructorAnswer.trim()}
                  className="flex-1 px-6 py-3 rounded-xl font-semibold text-white bg-green-600 hover:bg-green-700 shadow-lg shadow-green-200 transition-all active:scale-95 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:shadow-none"
                >
                  {isAnswering ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "Mark as Answered"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {questionToDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setQuestionToDelete(null)}
              className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-sm bg-white rounded-3xl shadow-2xl p-8 space-y-6"
            >
              <div className="space-y-2 text-center">
                <div className="w-12 h-12 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Trash2 className="w-6 h-6 text-red-500" />
                </div>
                <h3 className="text-xl font-bold tracking-tight text-neutral-900">
                  Are you sure you want to delete this question?
                </h3>
                <p className="text-sm text-neutral-500">
                  This action cannot be undone. The question will be removed from the feed.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={() => setQuestionToDelete(null)}
                  className="flex-1 px-6 py-3 rounded-xl font-semibold text-neutral-600 bg-neutral-100 hover:bg-neutral-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteQuestion}
                  className="flex-1 px-6 py-3 rounded-xl font-semibold text-white bg-red-500 hover:bg-red-600 shadow-lg shadow-red-200 transition-all active:scale-95"
                >
                  Confirm
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Sub-components ---

function QuestionForm({ user, classroomId }: { user: User, classroomId: string }) {
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setError("Question cannot be empty");
      return;
    }
    if (text.length > 300) {
      setError("Question exceeds limit (300 chars)");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // AI Moderation (Frontend)
      const apiKey = process.env.GEMINI_API_KEY;
      let modData = { isInappropriate: false, finalText: text, message: "" };

      if (apiKey) {
        try {
          const ai = new GoogleGenAI({ apiKey });
          const prompt = `
            You are an AI assistant for a classroom Q&A platform.
            Analyze the student's question below.

            If the question is inappropriate, offensive, or disrespectful:
            * Rewrite it into a polite and respectful academic question
            * OR provide a gentle warning message

            If the question is already appropriate:
            * Return the original text

            Return JSON format:
            {
              "isInappropriate": boolean,
              "finalText": string,
              "message": string
            }

            Student question: "${text}"
          `;

          const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
              responseMimeType: "application/json",
            }
          });

          const responseText = result.text;
          if (responseText) {
            modData = JSON.parse(responseText);
          }
        } catch (aiErr) {
          console.error("AI Moderation Error (Frontend):", aiErr);
          // Fallback to original text
        }
      }

      if (modData.isInappropriate) {
        setError(modData.message || "Your question was flagged as inappropriate.");
        setIsSubmitting(false);
        // We can optionally update the text area with the polite version
        if (modData.finalText) {
          setText(modData.finalText);
        }
        return;
      }

      const finalText = modData.finalText || text;

      // Submit to Firestore
      const newQuestionRef = doc(collection(db, 'questions'));
      await setDoc(newQuestionRef, {
        text: finalText,
        upvotes: 0,
        createdAt: Timestamp.now(),
        isSelected: false,
        authorId: user.uid,
        classroomId: classroomId
      });

      setText('');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'questions');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-neutral-200 rounded-2xl p-6 space-y-4 shadow-sm">
      <div className="space-y-2">
        <label className="text-sm font-semibold text-neutral-700">Ask Anonymously</label>
        <textarea 
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          placeholder="What's on your mind?"
          className="w-full min-h-[120px] p-4 bg-neutral-50 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none transition-all resize-none text-sm"
          maxLength={300}
        />
        <div className="flex justify-between items-center text-[10px] font-mono uppercase tracking-wider text-neutral-400">
          <span>{text.length} / 300</span>
          <span>Anonymous</span>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-xs font-medium">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      <button 
        type="submit"
        disabled={isSubmitting || !text.trim()}
        className="w-full bg-neutral-900 text-white py-3 rounded-xl font-medium hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400 transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
      >
        {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        Submit Question
      </button>
    </form>
  );
}

interface QuestionCardProps {
  key?: string | number;
  question: Question;
  onUpvote: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onAnswer?: () => void;
  isSelected: boolean;
  isInstructor: boolean;
  currentUserId?: string;
}

function QuestionCard({ question, onUpvote, onSelect, onDelete, onAnswer, isSelected, isInstructor, currentUserId }: QuestionCardProps) {
  const scale = Math.min(1 + (question.upvotes * 0.05), 1.2);
  const isTop = question.upvotes >= 5;
  const isAuthor = currentUserId === question.authorId;
  const isAnswered = question.isAnswered;

  return (
    <motion.div 
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={cn(
        "group relative border rounded-2xl p-6 transition-all duration-300",
        isAnswered ? "bg-green-50 border-green-200" : "bg-white border-neutral-200 shadow-sm hover:border-neutral-300",
        isSelected && !isAnswered ? "border-neutral-900 ring-2 ring-neutral-900 shadow-lg" : "",
        isTop && !isSelected && !isAnswered && "border-amber-200 bg-amber-50/30"
      )}
      style={{ transform: isAnswered ? 'none' : `scale(${scale})`, transformOrigin: 'left center' }}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2">
        {isInstructor && !isAnswered && onAnswer && (
          <button
            onClick={onAnswer}
            className="p-2 text-neutral-400 hover:text-green-600 hover:bg-green-50 rounded-full transition-all"
            title="Mark as Answered"
          >
            <CheckCircle2 className="w-4 h-4" />
          </button>
        )}
        {(isInstructor || isAuthor) && (
          <button
            onClick={onDelete}
            className="p-2 text-neutral-200 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
            title="Delete Question"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      
      <div className="flex items-start gap-4">
        <div className="flex-1 space-y-4">
          {/* Top-left: Timestamp */}
          <div className="flex items-center gap-2">
            {isAnswered && (
              <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-tighter bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                <CheckCircle2 className="w-3 h-3" />
                Answered
              </span>
            )}
            {isTop && !isAnswered && (
              <span className="text-[10px] font-bold uppercase tracking-tighter bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                Trending
              </span>
            )}
            <span className="text-[10px] font-mono text-neutral-400 uppercase tracking-widest">
              {new Date(question.createdAt.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          
          {/* Center: Question Text */}
          <p className={cn(
            "text-neutral-800 leading-relaxed",
            !isAnswered && question.upvotes > 10 ? "text-xl font-semibold" : "text-base font-medium"
          )}>
            {question.text}
          </p>

          {isAnswered && question.answer && (
            <div className="mt-4 p-4 bg-white/50 rounded-xl border border-green-100 space-y-2">
              <p className="text-sm font-semibold text-green-800 flex items-center gap-2">
                Instructor's Answer
              </p>
              <p className="text-sm text-neutral-700 leading-relaxed italic">
                "{question.answer}"
              </p>
            </div>
          )}

          {/* Bottom-left: Actions */}
          {!isAnswered && (
            <div className="flex items-center gap-4">
              <button 
                onClick={onUpvote}
                disabled={isInstructor}
                className={cn(
                  "flex items-center gap-1.5 transition-colors",
                  isInstructor ? "text-neutral-300 cursor-not-allowed" : "text-neutral-500 hover:text-neutral-900"
                )}
              >
                <ThumbsUp className="w-4 h-4" />
                <span className="text-sm font-bold">{question.upvotes}</span>
              </button>
              
              {isInstructor && (
                <button 
                  onClick={onSelect}
                  className={cn(
                    "flex items-center gap-1.5 text-sm font-medium transition-colors",
                    isSelected ? "text-neutral-900" : "text-neutral-400 hover:text-neutral-600"
                  )}
                >
                  {isSelected ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  {isSelected ? 'Selected' : 'Select'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

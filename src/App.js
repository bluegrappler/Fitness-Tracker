import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  getDocs,
  Timestamp,
} from 'firebase/firestore';
import {
  getAuth,
  signInWithCustomToken,
  signInAnonymously,
  onAuthStateChanged,
} from 'firebase/auth';

// Define the Firebase config to be used as a fallback if not provided by the environment.
const fallbackFirebaseConfig = {
  apiKey: "AIzaSyB364oqoNGpGs1KHQhFY75KsGy2gQwYjUI",
  authDomain: "fitness-tracker-ff53e.firebaseapp.com",
  projectId: "fitness-tracker-ff53e",
  storageBucket: "fitness-tracker-ff53e.firebasestorage.app",
  messagingSenderId: "608373111852",
  appId: "1:608373111852:web:af0dfb9dcc685947c2a589"
};

// --- Helper Functions (Provided by User) ---

// Utility function to format dates
const formatDate = (date) => {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

// Helper function to get the current exercise details based on the progressive schedule
const getDynamicExerciseDetails = (exercise) => {
  if (!exercise || !exercise.schedule || exercise.schedule.length === 0) {
    return { sets: 'N/A', reps: 'N/A' };
  }

  const lastCompletedDate = exercise.lastCompletedDate?.toDate();
  if (!lastCompletedDate) {
      // If never completed, return the details of the first phase
      const firstPhase = exercise.schedule[0];
      return { sets: firstPhase.sets, reps: firstPhase.reps };
  }

  const today = new Date();
  const weeksPassed = Math.floor((today - lastCompletedDate) / (1000 * 60 * 60 * 24 * 7));

  let totalWeeks = 0;
  for (const phase of exercise.schedule) {
    totalWeeks += phase.weeks;
    if (weeksPassed < totalWeeks) {
      return { sets: phase.sets, reps: phase.reps };
    }
  }

  // If all phases are completed, repeat the last phase
  const lastPhase = exercise.schedule[exercise.schedule.length - 1];
  return { sets: lastPhase.sets, reps: lastPhase.reps };
};

// Helper function to generate calendar data
const getCalendarData = (exercises, history, month, year) => {
  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const calendarData = {};

  const isWorkoutDay = (exercise, dateToCheck) => {
    if (!exercise) return false;

    const today = new Date();
    const isToday = dateToCheck.getFullYear() === today.getFullYear() && dateToCheck.getMonth() === today.getMonth() && dateToCheck.getDate() === today.getDate();

    if (!exercise.lastCompletedDate) {
      return isToday;
    }

    const lastCompleted = exercise.lastCompletedDate.toDate();
    const daysSinceLastCompletion = Math.floor((dateToCheck - lastCompleted) / (1000 * 60 * 60 * 24));

    if (daysSinceLastCompletion < 0 && !isToday) {
        return false;
    }

    let totalCycleDays = (exercise.frequency - 1) * exercise.restBetweenSessions + exercise.restBeforeNextRound + exercise.frequency;

    const dayInCycle = daysSinceLastCompletion % totalCycleDays;

    let scheduledDays = [];
    let currentDay = 0;
    for(let i = 0; i < exercise.frequency; i++) {
        scheduledDays.push(currentDay);
        currentDay += (1 + exercise.restBetweenSessions);
    }

    const shiftedDayInCycle = (dayInCycle + (totalCycleDays - (exercise.staggerDays || 0))) % totalCycleDays;

    return scheduledDays.includes(shiftedDayInCycle);
  };

  history.forEach(item => {
    const itemDate = item.completedAt.toDate();
    const dateKey = `${itemDate.getFullYear()}-${itemDate.getMonth()}-${itemDate.getDate()}`;
    if (!calendarData[dateKey]) {
      calendarData[dateKey] = {
        date: itemDate,
        status: 'green',
        exercises: new Set(),
        completed: true,
      };
    }
    calendarData[dateKey].exercises.add(item.name);
  });

  let currentDate = new Date(firstDayOfMonth);
  while (currentDate <= lastDayOfMonth) {
    const dateKey = `${currentDate.getFullYear()}-${currentDate.getMonth()}-${currentDate.getDate()}`;

    exercises.forEach(exercise => {
      if (isWorkoutDay(exercise, currentDate)) {
        if (!calendarData[dateKey]) {
          calendarData[dateKey] = {
            date: new Date(currentDate),
            status: 'red',
            exercises: new Set(),
            completed: false,
          };
        }
        calendarData[dateKey].exercises.add(exercise.name);
      }
    });
    currentDate.setDate(currentDate.getDate() + 1);
  }

  Object.values(calendarData).forEach(day => {
    day.exercises = Array.from(day.exercises);
    if(day.completed) {
      day.status = 'green';
    } else {
      day.status = 'red';
    }
  });

  return calendarData;
};

// --- Fitness Tracker Main App Component (Provided by User) ---

function FitnessTrackerApp({ db, auth, userId, appId, handleLogout }) {
  // State variables for the fitness tracker functionality
  const [currentPage, setCurrentPage] = useState('today');
  const [exercises, setExercises] = useState([]);
  const [history, setHistory] = useState([]);
  const [exerciseName, setExerciseName] = useState('');
  const [progressiveSchedule, setProgressiveSchedule] = useState([{ weeks: 1, sets: '', reps: '' }]);
  const [rest, setRest] = useState('');
  const [frequency, setFrequency] = useState('');
  const [restBetween, setRestBetween] = useState('');
  const [restBeforeNext, setRestBeforeNext] = useState('');
  const [staggerDays, setStaggerDays] = useState(0);
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());

  // Fetching data from Firestore
  useEffect(() => {
    if (!db || !userId) return;

    const exercisesRef = collection(db, `artifacts/${appId}/users/${userId}/exercises`);
    const historyRef = collection(db, `artifacts/${appId}/users/${userId}/history`);

    const unsubscribeExercises = onSnapshot(exercisesRef, (snapshot) => {
      const exercisesList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setExercises(exercisesList);
    });

    const unsubscribeHistory = onSnapshot(historyRef, (snapshot) => {
      const historyList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setHistory(historyList);
    });

    return () => {
      unsubscribeExercises();
      unsubscribeHistory();
    };
  }, [db, userId, appId]);

  // Handle changes to the progressive schedule form
  const handleScheduleChange = (index, event) => {
    const newSchedule = [...progressiveSchedule];
    newSchedule[index][event.target.name] = parseInt(event.target.value) || '';
    setProgressiveSchedule(newSchedule);
  };

  const handleAddPhase = () => {
    setProgressiveSchedule([...progressiveSchedule, { weeks: 1, sets: '', reps: '' }]);
  };

  const handleRemovePhase = (index) => {
    const newSchedule = [...progressiveSchedule];
    newSchedule.splice(index, 1);
    setProgressiveSchedule(newSchedule);
  };

  // Handle form submission for adding a new exercise schedule
  const handleAddSchedule = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage('');

    try {
      const exercisesRef = collection(db, `artifacts/${appId}/users/${userId}/exercises`);
      await setDoc(doc(exercisesRef, exerciseName), {
        name: exerciseName,
        rest: rest,
        frequency: parseInt(frequency),
        restBetweenSessions: parseInt(restBetween),
        restBeforeNextRound: parseInt(restBeforeNext),
        staggerDays: parseInt(staggerDays),
        schedule: progressiveSchedule.map(phase => ({
          weeks: parseInt(phase.weeks) || 0,
          sets: parseInt(phase.sets) || 0,
          reps: parseInt(phase.reps) || 0,
        })),
        lastCompletedDate: null,
        sessionCount: 0,
      });
      setMessage('Exercise schedule saved successfully!');
      setExerciseName('');
      setProgressiveSchedule([{ weeks: 1, sets: '', reps: '' }]);
      setRest('');
      setFrequency('');
      setRestBetween('');
      setRestBeforeNext('');
      setStaggerDays(0);
    } catch (e) {
      console.error('Error adding schedule:', e);
      setMessage('Error saving schedule.');
    } finally {
      setIsLoading(false);
    }
  };

  // Check if today is a workout day
  const isTodayAWorkoutDay = (exercise) => {
    if (!exercise) return false;

    const today = new Date();
    const dateToCheck = today;

    if (!exercise.lastCompletedDate) {
      return true;
    }

    const lastCompleted = exercise.lastCompletedDate.toDate();
    const daysSinceLastCompletion = Math.floor((dateToCheck - lastCompleted) / (1000 * 60 * 60 * 24));

    let totalCycleDays = (exercise.frequency - 1) * exercise.restBetweenSessions + exercise.restBeforeNextRound + exercise.frequency;

    const dayInCycle = daysSinceLastCompletion % totalCycleDays;

    let scheduledDays = [];
    let currentDay = 0;
    for(let i = 0; i < exercise.frequency; i++) {
        scheduledDays.push(currentDay);
        currentDay += (1 + exercise.restBetweenSessions);
    }

    const shiftedDayInCycle = (dayInCycle + (totalCycleDays - (exercise.staggerDays || 0))) % totalCycleDays;

    return scheduledDays.includes(shiftedDayInCycle);
  };

  // Handle marking an exercise as complete
  const handleMarkComplete = async (exerciseId) => {
    if (!db || !userId) return;

    try {
      const exerciseRef = doc(db, `artifacts/${appId}/users/${userId}/exercises/${exerciseId}`);
      const exerciseDoc = await getDoc(exerciseRef);
      const exerciseData = exerciseDoc.data();
      const { sets, reps } = getDynamicExerciseDetails(exerciseData);

      const newSessionCount = (exerciseData.sessionCount || 0) + 1;
      await updateDoc(exerciseRef, {
        lastCompletedDate: Timestamp.now(),
        sessionCount: newSessionCount,
      });

      const historyRef = collection(db, `artifacts/${appId}/users/${userId}/history`);
      await setDoc(doc(historyRef, Timestamp.now().toMillis().toString()), {
        name: exerciseData.name,
        sets: sets,
        reps: reps,
        rest: exerciseData.rest,
        completedAt: Timestamp.now(),
      });

      setMessage(`${exerciseData.name} completed successfully!`);
    } catch (e) {
      console.error('Error marking exercise as complete:', e);
      setMessage('Error marking exercise as complete.');
    }
  };

  const todayExercises = exercises.filter(isTodayAWorkoutDay);

  const renderTodayPage = () => (
    <div className="p-4 sm:p-8 space-y-4 sm:space-y-6">
      <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 text-center">Today's Workout</h2>
      <p className="text-sm sm:text-lg text-gray-600 text-center">{formatDate(new Date())}</p>
      {message && (
        <div className="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded relative text-center text-sm sm:text-base" role="alert">
          {message}
        </div>
      )}
      {todayExercises.length === 0 ? (
        <div className="p-4 sm:p-6 bg-yellow-100 rounded-xl shadow-md text-center">
          <p className="text-sm sm:text-xl text-yellow-700 font-semibold">No exercises due today! Enjoy your rest.</p>
        </div>
      ) : (
        todayExercises.map((exercise) => {
          const { sets, reps } = getDynamicExerciseDetails(exercise);
          return (
            <div key={exercise.id} className="p-4 sm:p-6 bg-white rounded-xl shadow-md space-y-3 sm:space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xl sm:text-2xl font-semibold text-blue-600">{exercise.name}</h3>
                <input
                  type="checkbox"
                  onChange={() => handleMarkComplete(exercise.id)}
                  className="form-checkbox h-6 w-6 text-blue-600 bg-gray-200 rounded focus:ring-blue-500 transition duration-150 ease-in-out"
                />
              </div>
              <p className="text-sm sm:text-base text-gray-700">
                <span className="font-medium">Details:</span> {sets} sets of {reps} reps with {exercise.rest} seconds rest between sets.
              </p>
              <p className="text-sm sm:text-base text-gray-700">
                <span className="font-medium">Schedule:</span> {exercise.frequency} times per week, with {exercise.restBetweenSessions} day(s) rest between sessions and {exercise.restBeforeNextRound} day(s) rest before the next round.
              </p>
              <p className="text-sm sm:text-base text-gray-700">
                <span className="font-medium">Stagger:</span> Starting on day {exercise.staggerDays} of the cycle.
              </p>
              <p className="text-xs sm:text-sm text-gray-500">
                Last completed: {formatDate(exercise.lastCompletedDate?.toDate() || null)}
              </p>
            </div>
          );
        })
      )}
    </div>
  );

  const renderHistoryPage = () => (
    <div className="p-4 sm:p-8 space-y-4 sm:space-y-6">
      <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 text-center">Exercise History</h2>
      {history.length === 0 ? (
        <p className="text-center text-sm sm:text-base text-gray-600">No completed exercises yet. Start a workout!</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {history.sort((a, b) => b.completedAt.toDate() - a.completedAt.toDate()).map((item) => (
            <div key={item.id} className="p-4 sm:p-6 bg-white rounded-xl shadow-md">
              <h3 className="text-lg sm:text-xl font-semibold text-blue-600">{item.name}</h3>
              <p className="text-sm sm:text-base text-gray-700 mt-2">
                <span className="font-medium">Details:</span> {item.sets} sets of {item.reps} reps
              </p>
              <p className="text-xs sm:text-sm text-gray-500 mt-1">
                Completed on: {formatDate(item.completedAt.toDate())}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderSetupPage = () => (
    <div className="p-4 sm:p-8 space-y-4 sm:space-y-6">
      <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 text-center">Setup a New Exercise</h2>
      {message && (
        <div className="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded relative text-center text-sm sm:text-base" role="alert">
          {message}
        </div>
      )}
      <form onSubmit={handleAddSchedule} className="bg-white p-4 sm:p-8 rounded-xl shadow-md space-y-4 sm:space-y-6">
        <div>
          <label htmlFor="name" className="block text-gray-700 font-semibold">Exercise Name</label>
          <input
            id="name"
            type="text"
            value={exerciseName}
            onChange={(e) => setExerciseName(e.target.value)}
            required
            className="w-full mt-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
          />
        </div>

        <div className="space-y-4 p-4 border border-gray-300 rounded-lg">
          <h3 className="text-lg font-semibold text-gray-800">Progressive Schedule</h3>
          {progressiveSchedule.map((phase, index) => (
            <div key={index} className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-4 items-end">
              <div className="flex-1">
                <label className="block text-gray-700 text-sm">Phase {index + 1} Duration (weeks)</label>
                <input
                  type="number"
                  name="weeks"
                  value={phase.weeks}
                  onChange={(e) => handleScheduleChange(index, e)}
                  required
                  className="w-full mt-1 p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                />
              </div>
              <div className="flex-1">
                <label className="block text-gray-700 text-sm">Sets</label>
                <input
                  type="number"
                  name="sets"
                  value={phase.sets}
                  onChange={(e) => handleScheduleChange(index, e)}
                  required
                  className="w-full mt-1 p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                />
              </div>
              <div className="flex-1">
                <label className="block text-gray-700 text-sm">Reps</label>
                <input
                  type="number"
                  name="reps"
                  value={phase.reps}
                  onChange={(e) => handleScheduleChange(index, e)}
                  required
                  className="w-full mt-1 p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
                />
              </div>
              {progressiveSchedule.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleRemovePhase(index)}
                  className="p-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors duration-150"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={handleAddPhase}
            className="w-full sm:w-auto mt-2 bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-2 px-4 rounded-lg transition-colors duration-150"
          >
            Add Phase
          </button>
        </div>

        <div>
          <label htmlFor="rest" className="block text-gray-700 font-semibold">Rest Time (e.g., 60-90s)</label>
          <input
            id="rest"
            type="text"
            value={rest}
            onChange={(e) => setRest(e.target.value)}
            required
            className="w-full mt-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
          />
        </div>
        <div>
          <label htmlFor="frequency" className="block text-gray-700 font-semibold">Frequency (times per cycle)</label>
          <input
            id="frequency"
            type="number"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            required
            className="w-full mt-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
          />
        </div>
        <div>
          <label htmlFor="restBetween" className="block text-gray-700 font-semibold">Rest Days Between Sessions</label>
          <input
            id="restBetween"
            type="number"
            value={restBetween}
            onChange={(e) => setRestBetween(e.target.value)}
            required
            className="w-full mt-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
          />
        </div>
        <div>
          <label htmlFor="restBeforeNext" className="block text-gray-700 font-semibold">Rest Days Before Next Round</label>
          <input
            id="restBeforeNext"
            type="number"
            value={restBeforeNext}
            onChange={(e) => setRestBeforeNext(e.target.value)}
            required
            className="w-full mt-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
          />
        </div>
        <div>
          <label htmlFor="staggerDays" className="block text-gray-700 font-semibold">Stagger Start Day (0 = first day of cycle)</label>
          <input
            id="staggerDays"
            type="number"
            value={staggerDays}
            onChange={(e) => setStaggerDays(e.target.value)}
            required
            className="w-full mt-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
          />
        </div>
        <button
          type="submit"
          disabled={isLoading}
          className={`w-full font-bold py-3 px-4 rounded-lg focus:outline-none focus:ring-4 transition duration-150 ease-in-out shadow-md
            ${!isLoading
              ? 'bg-blue-600 hover:bg-blue-700 text-white focus:ring-blue-300'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
        >
          {isLoading ? 'Saving...' : 'Save Schedule'}
        </button>
      </form>
    </div>
  );

  const renderCalendarPage = () => {
    const calendarData = getCalendarData(exercises, history, currentMonth, currentYear);
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === currentYear && today.getMonth() === currentMonth;

    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const days = [];

    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="p-2"></div>);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(currentYear, currentMonth, day);
      const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const dayData = calendarData[dateKey] || {};
      const statusClass = dayData.status === 'green' ? 'bg-green-200' : dayData.status === 'red' ? 'bg-red-200' : 'bg-gray-100';
      const isToday = isCurrentMonth && day === today.getDate();
      const todayClass = isToday ? 'border-2 border-blue-500 shadow-md' : '';

      days.push(
        <div key={day} className={`p-1 sm:p-2 rounded-xl text-center transition-colors duration-200 ${statusClass} ${todayClass}`}>
          <div className="font-semibold text-sm sm:text-base">{day}</div>
          {dayData.exercises && dayData.exercises.length > 0 && (
            <div className="mt-1 text-xs text-gray-600">
              {dayData.exercises.map((name, index) => (
                <div key={index} className="text-[10px] sm:text-xs">{name}</div>
              ))}
            </div>
          )}
        </div>
      );
    }

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    const handlePreviousMonth = () => {
      setCurrentMonth(prev => {
        if (prev === 0) {
          setCurrentYear(y => y - 1);
          return 11;
        }
        return prev - 1;
      });
    };

    const handleNextMonth = () => {
      setCurrentMonth(prev => {
        if (prev === 11) {
          setCurrentYear(y => y + 1);
          return 0;
        }
        return prev + 1;
      });
    };

    return (
      <div className="p-4 sm:p-8 space-y-4 sm:space-y-6">
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 text-center">Workout Calendar</h2>
        <div className="flex justify-between items-center mb-4">
          <button onClick={handlePreviousMonth} className="p-2 rounded-full bg-gray-200 hover:bg-gray-300 transition-colors duration-200">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="text-lg sm:text-xl font-bold">{monthNames[currentMonth]} {currentYear}</div>
          <button onClick={handleNextMonth} className="p-2 rounded-full bg-gray-200 hover:bg-gray-300 transition-colors duration-200">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1 sm:gap-2 text-center font-bold text-gray-600 text-sm">
          <div>Sun</div>
          <div>Mon</div>
          <div>Tue</div>
          <div>Wed</div>
          <div>Thu</div>
          <div>Fri</div>
          <div>Sat</div>
        </div>
        <div className="grid grid-cols-7 gap-1 sm:gap-2">
          {days}
        </div>
        <div className="mt-4 sm:mt-6 p-4 bg-white rounded-xl shadow-md text-gray-700 text-sm">
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 bg-green-400 rounded-full"></div>
            <span>Completed workout</span>
          </div>
          <div className="flex items-center space-x-2 mt-2">
            <div className="w-4 h-4 bg-red-400 rounded-full"></div>
            <span>Scheduled workout, but incomplete</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-100 font-sans flex flex-col items-center">
      <div className="w-full max-w-4xl p-2 sm:p-4">
        {/* Navigation Bar */}
        <nav className="bg-white rounded-2xl shadow-lg p-2 flex justify-around mb-4 sm:mb-8">
          <button
            onClick={() => setCurrentPage('today')}
            className={`flex-1 text-center py-2 px-1 sm:px-4 rounded-lg font-semibold text-xs sm:text-base transition-all duration-300 ${currentPage === 'today' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-600 hover:bg-gray-200'}`}
          >
            Today
          </button>
          <button
            onClick={() => setCurrentPage('history')}
            className={`flex-1 text-center py-2 px-1 sm:px-4 rounded-lg font-semibold text-xs sm:text-base transition-all duration-300 ${currentPage === 'history' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-600 hover:bg-gray-200'}`}
          >
            History
          </button>
          <button
            onClick={() => setCurrentPage('calendar')}
            className={`flex-1 text-center py-2 px-1 sm:px-4 rounded-lg font-semibold text-xs sm:text-base transition-all duration-300 ${currentPage === 'calendar' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-600 hover:bg-gray-200'}`}
          >
            Calendar
          </button>
          <button
            onClick={() => setCurrentPage('setup')}
            className={`flex-1 text-center py-2 px-1 sm:px-4 rounded-lg font-semibold text-xs sm:text-base transition-all duration-300 ${currentPage === 'setup' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-600 hover:bg-gray-200'}`}
          >
            Setup
          </button>
          <button
            onClick={handleLogout}
            className="flex-1 text-center py-2 px-1 sm:px-4 rounded-lg font-semibold text-xs sm:text-base transition-all duration-300 text-red-600 hover:bg-gray-200"
          >
            Log Out
          </button>
        </nav>

        {/* Display User ID for debugging/collaboration */}
        {userId && (
          <div className="text-center text-xs sm:text-sm text-gray-500 mb-2 sm:mb-4 break-all">
            User ID: {userId}
          </div>
        )}

        {/* Main Content Area */}
        <main className="w-full">
          {(() => {
            switch (currentPage) {
              case 'today':
                return renderTodayPage();
              case 'history':
                return renderHistoryPage();
              case 'calendar':
                return renderCalendarPage();
              case 'setup':
                return renderSetupPage();
              default:
                return null;
            }
          })()}
        </main>
      </div>
    </div>
  );
}


// --- Root App Component with Conditional Rendering ---

export default function App() {
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [message, setMessage] = useState('');

  // Check if __initial_auth_token and __app_id are defined, if not, create fallback variables.
  const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
  const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
  const firebaseConfigCanvas = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : fallbackFirebaseConfig;

  // Firebase Initialization and Authentication
  useEffect(() => {
  const initApp = async () => {
    try {
      console.log("Firebase init started.");
      const app = initializeApp(firebaseConfigCanvas);
      const firestoreDb = getFirestore(app);
      const firestoreAuth = getAuth(app);
      setDb(firestoreDb);
      setAuth(firestoreAuth);

      console.log("Firebase services initialized. Attempting sign-in...");
      if (initialAuthToken) {
        await signInWithCustomToken(firestoreAuth, initialAuthToken);
      } else {
        await signInAnonymously(firestoreAuth);
      }
      console.log("Sign-in function called. Waiting for auth state change...");

      const unsubscribe = onAuthStateChanged(firestoreAuth, (user) => {
        console.log("Auth state changed. User is:", user);
        if (user) {
          setUserId(user.uid);
          setIsAuthReady(true);
          console.log("User authenticated. UI should now load.");
        } else {
          console.log("Auth state changed, but user is not signed in.");
        }
      });
      return () => unsubscribe();
    } catch (e) {
      console.error('Error initializing Firebase:', e);
    }
  };
  initApp();
}, [initialAuthToken, firebaseConfigCanvas]);

  // Handle logout
  const handleLogout = () => {
    setIsLoggedIn(false);
    setMessage('You have been logged out.');
  };

  // Show the main app if logged in and authentication is ready
  return (
    <div className="min-h-screen bg-gray-100 font-sans flex flex-col items-center">
      {!isAuthReady ? (
        <div className="text-center text-xl text-gray-500 p-8">Loading app...</div>
      ) : (
        <FitnessTrackerApp
          db={db}
          auth={auth}
          userId={userId}
          appId={appId}
          handleLogout={handleLogout}
        />
      )}
    </div>
  );
}

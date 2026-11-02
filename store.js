// All reads and writes to Firebase live here.
const Store = (() => {
  let auth;
  let db;

  const withId = (doc) => ({ id: doc.id, ...doc.data() });

  async function listAll(collection, ownerEmail) {
    const ref = db.collection(collection);
    const query = ownerEmail ? ref.where("ownerEmail", "==", ownerEmail) : ref;
    return (await query.get()).docs.map(withId);
  }

  return {
    isConfigured() {
      return Boolean(FIREBASE_CONFIG.projectId && window.firebase);
    },

    onAuthChange(callback) {
      firebase.initializeApp(FIREBASE_CONFIG);
      auth = firebase.auth();
      db = firebase.firestore();
      auth.onAuthStateChanged(callback);
    },

    signIn() {
      return auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    },

    signOut() {
      return auth.signOut();
    },

    async getMember(email) {
      const doc = await db.collection("members").doc(email).get();
      return doc.exists ? { email: doc.id, ...doc.data() } : null;
    },

    async listMembers() {
      return (await db.collection("members").get()).docs.map((doc) => ({ email: doc.id, ...doc.data() }));
    },

    // Pass an email to get one person's entries. Only reviewers may leave it out.
    listAvailability: (ownerEmail) => listAll("availability", ownerEmail),
    listTimeOff: (ownerEmail) => listAll("timeOff", ownerEmail),

    saveAvailability(id, data) {
      const ref = db.collection("availability");
      return id ? ref.doc(id).set(data) : ref.add(data);
    },

    // Applies a set of schedule changes at once, so a failure can't leave them half saved.
    applyClassPlan({ creates = [], updates = [], deletes = [] }) {
      const batch = db.batch();
      const ref = db.collection("availability");
      for (const data of creates) batch.set(ref.doc(), data);
      for (const { id, data } of updates) batch.set(ref.doc(id), data);
      for (const id of deletes) batch.delete(ref.doc(id));
      return batch.commit();
    },

    listChangeRequests: (ownerEmail) => listAll("changeRequests", ownerEmail),
    // Tells reviewers about a Grad Student/Post-Doc's change; the Apps Script emails these and then deletes them.
    createNotice: (data) => db.collection("notices").add(data),
    createChangeRequest: (data) => db.collection("changeRequests").add(data),
    deleteChangeRequest: (id) => db.collection("changeRequests").doc(id).delete(),
    decideChangeRequest: (id, decision) => db.collection("changeRequests").doc(id).update(decision),

    // Approving applies the change and records the decision together.
    approveChangeRequest(id, { creates, updates, deletes }, decision) {
      const batch = db.batch();
      const ref = db.collection("availability");
      for (const data of creates) batch.set(ref.doc(), data);
      for (const { id: entryId, data } of updates) batch.set(ref.doc(entryId), data);
      for (const entryId of deletes) batch.delete(ref.doc(entryId));
      batch.update(db.collection("changeRequests").doc(id), decision);
      return batch.commit();
    },

    async listAppointments() {
      return (await db.collection("appointments").get()).docs.map(withId);
    },

    // A change to a default visit is saved under a fixed id for its date, so there's only ever one per day.
    saveAppointment(appointment, data) {
      const ref = db.collection("appointments");
      if (appointment.id) return ref.doc(appointment.id).set(data);
      if (appointment.defaultFor) return ref.doc(`default-${appointment.defaultFor}`).set(data);
      return ref.add(data);
    },

    deleteAppointment: (id) => db.collection("appointments").doc(id).delete(),

    deleteAvailability: (id) => db.collection("availability").doc(id).delete(),

    saveTimeOff(id, data) {
      const ref = db.collection("timeOff");
      return id ? ref.doc(id).set(data) : ref.add(data);
    },

    deleteTimeOff: (id) => db.collection("timeOff").doc(id).delete(),

    decideTimeOff(id, decision) {
      return db.collection("timeOff").doc(id).update(decision);
    },

    saveMember(email, data) {
      return db.collection("members").doc(email).set(data);
    },

    // Removing someone also removes their schedule, so nothing of theirs is left behind.
    async deleteMember(email) {
      const [availability, timeOff, changes] = await Promise.all([
        listAll("availability", email),
        listAll("timeOff", email),
        listAll("changeRequests", email),
      ]);
      const batch = db.batch();
      for (const { id } of availability) batch.delete(db.collection("availability").doc(id));
      for (const { id } of timeOff) batch.delete(db.collection("timeOff").doc(id));
      for (const { id } of changes) batch.delete(db.collection("changeRequests").doc(id));
      batch.delete(db.collection("members").doc(email));
      return batch.commit();
    },
  };
})();

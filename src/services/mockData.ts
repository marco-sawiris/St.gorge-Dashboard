import { Student } from '../types/student';
import { FollowupRecord } from '../types/followup';
import { getNearestFridayString } from '../utils/arabicUtils';
import { getIndexedDB, idbGetStudents } from './indexedDbService';

const currentFriday = getNearestFridayString();

export const INITIAL_MOCK_STUDENTS: Student[] = [
  {
    id: 'mock-std-01',
    code: 'SG-101',
    name: 'مارك هاني جورج',
    servant: 'مينا كمال',
    phoneStudent: '01221112233',
    phoneParent1: '01005556677',
    phoneParent2: '01114448899',
    birthDate: '2010-04-12',
    area: 'الزيتون الغربية',
    address: '14 شارع طومانباي، أمام كنيسة العذراء',
    notes: 'مواظب على القداس الأسبوعي وشماس متميز',
    followupStatus: 'تم تليفونياً',
    attendanceTotal: 18,
    attendanceMonth: 4,
    attendanceStatus: 'حاضر',
    sourceSheet: 'نشط',
    version: 1,
    att: {
      [currentFriday]: true,
      '2026-11-06': true,
      '2026-10-30': true,
      '2026-10-23': true
    },
    fu: {
      [currentFriday]: 'تم تليفونياً',
      '2026-11-06': 'واتساب'
    }
  },
  {
    id: 'mock-std-02',
    code: 'SG-102',
    name: 'بيتر سامح فؤاد',
    servant: 'مينا كمال',
    phoneStudent: '01223334455',
    phoneParent1: '01006667788',
    phoneParent2: '',
    birthDate: '2010-08-22',
    area: 'طومانباي',
    address: '22 شارع ترعة الجبل، الزيتون',
    notes: 'يعزف كيبورد في كورال الكنيسة',
    followupStatus: 'تم بزيارة',
    attendanceTotal: 15,
    attendanceMonth: 3,
    attendanceStatus: 'حاضر',
    sourceSheet: 'نشط',
    version: 1,
    att: {
      [currentFriday]: true,
      '2026-11-06': true,
      '2026-10-30': false
    },
    fu: {
      [currentFriday]: 'تم بزيارة'
    }
  },
  {
    id: 'mock-std-03',
    code: 'SG-103',
    name: 'يوحنا مجدي نصيف',
    servant: 'بيتر مجدي',
    phoneStudent: '01224445566',
    phoneParent1: '01007778899',
    phoneParent2: '01119990011',
    birthDate: '2010-11-05',
    area: 'ابن سندر',
    address: '8 شارع ابن سندر، بالقرب من الحديقة',
    notes: 'عنده تدريب نادي يوم الجمعة أحياناً',
    followupStatus: 'واتساب',
    attendanceTotal: 12,
    attendanceMonth: 2,
    attendanceStatus: 'غائب',
    sourceSheet: 'نشط',
    version: 1,
    att: {
      [currentFriday]: false,
      '2026-11-06': true,
      '2026-10-30': true
    },
    fu: {
      [currentFriday]: 'واتساب'
    }
  },
  {
    id: 'mock-std-04',
    code: 'SG-104',
    name: 'كيرلس رفعت لبيب',
    servant: 'بيتر مجدي',
    phoneStudent: '01225556677',
    phoneParent1: '01008889900',
    phoneParent2: '',
    birthDate: '2011-01-18',
    area: 'سليم الأول',
    address: '35 شارع سليم الأول، الزيتون',
    notes: 'يحتاج تشجيع على حفظ الألحان',
    followupStatus: 'رسالة نصية',
    attendanceTotal: 14,
    attendanceMonth: 3,
    attendanceStatus: 'حاضر',
    sourceSheet: 'نشط',
    version: 1,
    att: {
      [currentFriday]: true,
      '2026-11-06': true,
      '2026-10-30': true
    },
    fu: {
      [currentFriday]: 'رسالة نصية'
    }
  },
  {
    id: 'mock-std-05',
    code: 'SG-105',
    name: 'أنتوني ناصف شحاتة',
    servant: 'فادي عاطف',
    phoneStudent: '01226667788',
    phoneParent1: '01009990011',
    phoneParent2: '01112223344',
    birthDate: '2010-09-30',
    area: 'سراي القبة',
    address: '19 شارع قصر القبة، بالقرب من المحطة',
    notes: 'متميز في دروس دراسات الكتاب المقدس',
    followupStatus: 'تم تليفونياً',
    attendanceTotal: 16,
    attendanceMonth: 4,
    attendanceStatus: 'حاضر',
    sourceSheet: 'نشط',
    version: 1,
    att: {
      [currentFriday]: true,
      '2026-11-06': true,
      '2026-10-30': true
    },
    fu: {
      [currentFriday]: 'تم تليفونياً'
    }
  },
  {
    id: 'mock-std-06',
    code: 'SG-106',
    name: 'ديفيد أيمن وجيه',
    servant: 'فادي عاطف',
    phoneStudent: '01227778899',
    phoneParent1: '01001112233',
    phoneParent2: '',
    birthDate: '2011-03-14',
    area: 'حلمية الزيتون',
    address: '5 شارع نصوح، حلمية الزيتون',
    notes: 'كان مسافراً مع الأسرة الأسبوع الماضي',
    followupStatus: 'بدون',
    attendanceTotal: 8,
    attendanceMonth: 1,
    attendanceStatus: 'غائب',
    sourceSheet: 'غير حاضر',
    version: 1,
    att: {
      [currentFriday]: false,
      '2026-11-06': false,
      '2026-10-30': true
    },
    fu: {}
  },
  {
    id: 'mock-std-07',
    code: 'SG-107',
    name: 'مينا عماد فهيم',
    servant: 'مكاريوس نبيل',
    phoneStudent: '01228889900',
    phoneParent1: '01002223344',
    phoneParent2: '01113334455',
    birthDate: '2010-07-09',
    area: 'الزيتون الغربية',
    address: '11 شارع سنان باشا، الزيتون',
    notes: 'مواظب على خدمة المسرح الكنسي',
    followupStatus: 'تم تليفونياً',
    attendanceTotal: 17,
    attendanceMonth: 4,
    attendanceStatus: 'حاضر',
    sourceSheet: 'نشط',
    version: 1,
    att: {
      [currentFriday]: true,
      '2026-11-06': true,
      '2026-10-30': true
    },
    fu: {
      [currentFriday]: 'تم تليفونياً'
    }
  },
  {
    id: 'mock-std-08',
    code: 'SG-108',
    name: 'توماس رأفت غالي',
    servant: 'مكاريوس نبيل',
    phoneStudent: '01229990011',
    phoneParent1: '01003334455',
    phoneParent2: '',
    birthDate: '2010-12-25',
    area: 'طومانباي',
    address: '42 شارع الأصبغ، متفرع من طومانباي',
    notes: 'انتقل لسكن جديد قريباً ويحتاج متابعة العنوان',
    followupStatus: 'تم بزيارة',
    attendanceTotal: 7,
    attendanceMonth: 1,
    attendanceStatus: 'غائب',
    sourceSheet: 'غير حاضر',
    version: 1,
    att: {
      [currentFriday]: false,
      '2026-11-06': false,
      '2026-10-30': false
    },
    fu: {
      [currentFriday]: 'تم بزيارة'
    }
  },
  {
    id: 'mock-std-09',
    code: 'SG-109',
    name: 'ستيفن عاطف صبحي',
    servant: 'كيرلس سامي',
    phoneStudent: '01220001122',
    phoneParent1: '01004445566',
    phoneParent2: '01115556677',
    birthDate: '2010-02-17',
    area: 'ابن سندر',
    address: '16 شارع عزيز المصري، الزيتون',
    notes: 'فصل البابا شنودة المتميز في دراسة الطقس',
    followupStatus: 'واتساب',
    attendanceTotal: 20,
    attendanceMonth: 4,
    attendanceStatus: 'حاضر',
    sourceSheet: 'فصل البابا شنودة',
    version: 1,
    att: {
      [currentFriday]: true,
      '2026-11-06': true,
      '2026-10-30': true
    },
    fu: {
      [currentFriday]: 'واتساب'
    }
  },
  {
    id: 'mock-std-10',
    code: 'SG-110',
    name: 'جورج ممدوح سمير',
    servant: 'كيرلس سامي',
    phoneStudent: '01221113344',
    phoneParent1: '01005557788',
    phoneParent2: '',
    birthDate: '2010-06-11',
    area: 'سليم الأول',
    address: '50 شارع سليم الأول، أمام مدرسة العائلة المقدسة',
    notes: 'فصل البابا شنودة - شماس رتبة إبصالتس',
    followupStatus: 'تم تليفونياً',
    attendanceTotal: 19,
    attendanceMonth: 4,
    attendanceStatus: 'حاضر',
    sourceSheet: 'فصل البابا شنودة',
    version: 1,
    att: {
      [currentFriday]: true,
      '2026-11-06': true,
      '2026-10-30': true
    },
    fu: {
      [currentFriday]: 'تم تليفونياً'
    }
  },
  {
    id: 'mock-std-11',
    code: 'SG-111',
    name: 'بولا يوسف كامل',
    servant: 'يوسف عادل',
    phoneStudent: '01222224455',
    phoneParent1: '01006668899',
    phoneParent2: '01116667788',
    birthDate: '2011-05-04',
    area: 'حلمية الزيتون',
    address: '28 شارع منشية التحرير، الزيتون',
    notes: 'غير نشط بسبب تغيير مواعيد الدروس الخصوصية',
    followupStatus: 'تم تليفونياً',
    attendanceTotal: 3,
    attendanceMonth: 0,
    attendanceStatus: 'غائب',
    sourceSheet: 'غير نشط',
    version: 1,
    att: {
      [currentFriday]: false,
      '2026-11-06': false,
      '2026-10-30': false
    },
    fu: {
      [currentFriday]: 'تم تليفونياً'
    }
  },
  {
    id: 'mock-std-12',
    code: 'SG-112',
    name: 'مارتن إبراهيم شاكر',
    servant: 'يوسف عادل',
    phoneStudent: '01223335566',
    phoneParent1: '01007779900',
    phoneParent2: '',
    birthDate: '2010-10-19',
    area: 'سراي القبة',
    address: '7 شارع الدويدار، سراي القبة',
    notes: 'يحب النشاط الرياضي ومسابقات كرة القدم',
    followupStatus: 'واتساب',
    attendanceTotal: 13,
    attendanceMonth: 3,
    attendanceStatus: 'حاضر',
    sourceSheet: 'نشط',
    version: 1,
    att: {
      [currentFriday]: true,
      '2026-11-06': false,
      '2026-10-30': true
    },
    fu: {
      [currentFriday]: 'واتساب'
    }
  }
];

export const INITIAL_MOCK_FOLLOWUPS: FollowupRecord[] = [
  {
    id: 'fu-rec-01',
    date: '2026-11-10',
    fridayDate: currentFriday,
    studentId: 'mock-std-01',
    studentCode: 'SG-101',
    studentName: 'مارك هاني جورج',
    servant: 'مينا كمال',
    type: 'تم تليفونياً',
    notes: 'تم الاتصال بالوالد والتأكيد على الحضور الساعة 8:30 ص للقداس'
  },
  {
    id: 'fu-rec-02',
    date: '2026-11-09',
    fridayDate: currentFriday,
    studentId: 'mock-std-02',
    studentCode: 'SG-102',
    studentName: 'بيتر سامح فؤاد',
    servant: 'مينا كمال',
    type: 'تم بزيارة',
    notes: 'زيارة منزلية مباركة بحضور الأسرة وتم تشجيعه على الحضور'
  },
  {
    id: 'fu-rec-03',
    date: '2026-11-08',
    fridayDate: currentFriday,
    studentId: 'mock-std-03',
    studentCode: 'SG-103',
    studentName: 'يوحنا مجدي نصيف',
    servant: 'بيتر مجدي',
    type: 'واتساب',
    notes: 'تواصل عبر واتساب والاعتذار لوجود بطولة سباحة هذا الأسبوع'
  },
  {
    id: 'fu-rec-04',
    date: '2026-11-07',
    fridayDate: currentFriday,
    studentId: 'mock-std-05',
    studentCode: 'SG-105',
    studentName: 'أنتوني ناصف شحاتة',
    servant: 'فادي عاطف',
    type: 'تم تليفونياً',
    notes: 'مكالمة تشجيعية لتحضير مقدمة مسابقة الكتاب المقدس'
  },
  {
    id: 'fu-rec-05',
    date: '2026-11-05',
    fridayDate: currentFriday,
    studentId: 'mock-std-08',
    studentCode: 'SG-108',
    studentName: 'توماس رأفت غالي',
    servant: 'مكاريوس نبيل',
    type: 'تم بزيارة',
    notes: 'الاطمئنان على المنزل الجديد وترتيب حضور الجمعة القادمة'
  }
];

/**
 * Seeds initial mock data if and only if IndexedDB is currently empty.
 * Guarantees zero overwrite of existing local student records.
 */
export async function seedInitialMockDataIfEmpty(): Promise<boolean> {
  try {
    const existing = await idbGetStudents();
    if (existing && existing.length > 0) {
      return false; // Database already contains user data, do not overwrite!
    }

    const db = await getIndexedDB();
    const tx = db.transaction(['students', 'followup'], 'readwrite');
    const studentStore = tx.objectStore('students');
    const followupStore = tx.objectStore('followup');

    for (const student of INITIAL_MOCK_STUDENTS) {
      studentStore.put(student);
    }
    for (const fu of INITIAL_MOCK_FOLLOWUPS) {
      followupStore.put(fu);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return true;
  } catch (err) {
    console.warn('Seeding initial mock data warning:', err);
    return false;
  }
}

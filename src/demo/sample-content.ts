import { PNG_1X1, bodySp, buildPptx, equationShape, mr, para, run, simpleSlide, tableFrame, textBox, titleSp, type DeckSpec } from '../../tests/fixtures/pptx-builder';

/**
 * The sample course of the public demo (docs/DEMO.md): two short lectures and the study material for them, written for this
 * demo. The subject, the units, the tower and mast names and every rule are INVENTED; nothing here comes from a real course, a
 * real person or a real institution. The lecture files are made with the same synthetic deck builder the tests use (this is the
 * one place where application code reaches into tests/, and only the demo build includes it).
 *
 * tests/demo.sample-course.test.ts imports the material through the app's own code and fails if a cited quote is not on its
 * slide, if a question breaks the exam-question rules, or if anything real-looking slips in.
 */

export const SAMPLE_COURSE = { name: 'Skyship Navigation (invented demo course)', code: 'DEMO 101' } as const;

const sub = (base: string, s: string) => `<m:sSub><m:e>${base}</m:e><m:sub>${s}</m:sub></m:sSub>`;
const mono = (t: string) => para([run(t, { font: 'Consolas' })], { bullet: 'none' });
/** A body line small enough that the formula below it never overlaps the text. */
const line = (t: string, bullet?: 'none') => para([run(t, { sz: 2400 })], bullet ? { bullet } : {});
/** A symbol with a subscript, drawn the way PowerPoint stores it. */
const symbol = (name: string, subscript: string) => [run(name, { sz: 2400 }), run(subscript, { sz: 2400, baseline: -25000 })];
/** Where a formula sits on the slide: below the body text. */
const BELOW_TEXT: [number, number, number, number] = [1000000, 5300000, 4500000, 800000];

/** An equation shape needs the picture it falls back to; the builder wants it declared on every slide that has one. */
const picture = { rels: { rIdImg1: ['image', '../media/image1.png'] } as Record<string, [string, string]>, parts: { 'ppt/media/image1.png': PNG_1X1 } };

/** d_air = d_chart × S */
const SCALE_OMML = sub(mr('d'), mr('air')) + mr('=') + sub(mr('d'), mr('chart')) + mr('×S');
/** d = v × t */
const DISTANCE_OMML = mr('d=v×t');
/** v_g = v_a ± v_w */
const WIND_OMML = sub(mr('v'), mr('g')) + mr('=') + sub(mr('v'), mr('a')) + mr('±') + sub(mr('v'), mr('w'));

export const PLOT_LEG = ['PLOT-LEG(start, heading, ground_speed, hours)', '  distance = ground_speed * hours', '  end = the point at that distance from start along heading', '  mark end on the chart', '  return end'];

export function lectureOneSpec(): DeckSpec {
  return {
    title: 'Reading a sky chart',
    author: 'Invented Author',
    slides: [
      { layout: 1, shapes: titleSp(2, 'Skyship Navigation: Reading a Sky Chart', 'ctrTitle') + bodySp(3, [para('Lecture 1 of an invented demo course')]) },
      simpleSlide('What you will learn', [
        'Name the four parts of a sky chart',
        'Read the symbols for beacon towers, mooring masts and storm cells',
        'Turn a distance on the chart into a distance in the air',
        'Choose a safe wind band for a leg',
      ]),
      simpleSlide(
        'The four parts of a sky chart',
        ['The legend explains every symbol on the chart', 'The compass rose shows north, with the compass offset printed beside it', 'Wind bands are shaded strips that show how strong the wind is at each height', 'Landmarks are the fixed points you steer by'],
        'Hold up a printed chart and let the class find each part before you name it. Every place on the demo chart is invented.',
      ),
      {
        shapes:
          titleSp(2, 'Chart symbols') +
          tableFrame(4, [
            ['Symbol', 'Name', 'What it tells you'],
            ['Triangle', 'Beacon tower', 'A fixed light that can be seen from 40 km away'],
            ['Circle', 'Mooring mast', 'A safe place to tie up the ship'],
            ['Wavy line', 'Wind band edge', 'The border between two wind bands'],
            ['Cross', 'Storm cell', 'Keep at least 15 km away'],
          ]),
      },
      {
        shapes:
          titleSp(2, 'Scale and distance') +
          bodySp(3, [
            line('The scale tells you how far one centimetre on the chart is in the air.'),
            line('A scale of 1 : 500 000 means that 1 cm on the chart is 5 km in the air.'),
            line('Example: 6 cm on a chart with scale 1 : 500 000 is 30 km in the air.'),
            para([...symbol('d', 'air'), run(' is the distance in the air, ', { sz: 2400 }), ...symbol('d', 'chart'), run(' the distance on the chart and S the scale.', { sz: 2400 })], { bullet: 'none' }),
          ]) +
          equationShape(5, SCALE_OMML, BELOW_TEXT),
        ...picture,
      },
      simpleSlide(
        'Wind bands',
        ['Band 1: from the ground to 500 m. Light, gusty wind.', 'Band 2: from 500 m to 1 500 m. Steady wind, best for long legs.', 'Band 3: above 1 500 m. Strong wind, use it only with a tail wind.'],
        'The band limits belong to the invented demo world; they are not real flying rules.',
      ),
      simpleSlide('Summary', [
        'A sky chart has a legend, a compass rose, wind bands and landmarks',
        'Symbols tell you where to steer and what to avoid',
        'Distance in the air is the distance on the chart times the scale',
        'Band 2 is the best band for a long leg',
      ]),
    ],
  };
}

export function lectureTwoSpec(): DeckSpec {
  return {
    title: 'Dead reckoning aloft',
    author: 'Invented Author',
    slides: [
      { layout: 1, shapes: titleSp(2, 'Skyship Navigation: Dead Reckoning Aloft', 'ctrTitle') + bodySp(3, [para('Lecture 2 of an invented demo course')]) },
      simpleSlide('What dead reckoning means', [
        'Dead reckoning is working out where you are from where you started, your heading, your speed and the time that has passed',
        'It needs no landmarks, so it works in cloud',
        'Its error grows with every hour, so you correct it whenever you see a landmark',
      ]),
      {
        shapes:
          titleSp(2, 'Distance, speed and time') +
          bodySp(3, [
            line('The distance travelled is the ground speed multiplied by the time.'),
            line('d is the distance, v is the ground speed and t is the time.', 'none'),
            line('Example: a skyship that holds 24 km/h for 2.5 hours travels 60 km.'),
          ]) +
          equationShape(5, DISTANCE_OMML, BELOW_TEXT),
        ...picture,
        notes: 'Work the example on the board with the class before showing the formula.',
      },
      {
        shapes:
          titleSp(2, 'Wind changes your ground speed') +
          bodySp(3, [
            line('Ground speed is the speed over the land below you'),
            line('A tail wind adds its speed to your airspeed'),
            line('A head wind takes its speed away'),
            line('Example: airspeed 20 km/h with a 4 km/h head wind gives a ground speed of 16 km/h'),
            para([...symbol('v', 'g'), run(' is the ground speed, ', { sz: 2400 }), ...symbol('v', 'a'), run(' the airspeed and ', { sz: 2400 }), ...symbol('v', 'w'), run(' the wind speed.', { sz: 2400 })], { bullet: 'none' }),
          ]) +
          equationShape(5, WIND_OMML, BELOW_TEXT),
        ...picture,
      },
      {
        shapes: titleSp(2, 'Plotting one leg') + textBox(4, 700000, 1700000, 7200000, 2000000, PLOT_LEG.map(mono)) + bodySp(3, [para('Repeat for each leg. The end of one leg is the start of the next.')]),
      },
      {
        shapes:
          titleSp(2, 'Checking your position') +
          tableFrame(4, [
            ['Check', 'When', 'Allowed error'],
            ['Beacon fix', 'Every hour', '2 km'],
            ['Mast sighting', 'At each mooring', 'None, the mast is a known point'],
            ['Star sight', 'Night legs only', '5 km'],
          ]),
      },
      simpleSlide('Summary', [
        'Dead reckoning estimates your position from the start, heading, speed and time',
        'Ground speed is airspeed plus a tail wind or minus a head wind',
        'Plot one leg at a time and check against landmarks',
      ]),
    ],
  };
}

export interface SampleLecture {
  fileName: string;
  bytes: Uint8Array;
}

/** The two lecture files, built when needed (a few milliseconds). */
export function sampleLectures(): SampleLecture[] {
  return [
    { fileName: 'Lecture 1 - Reading a sky chart.pptx', bytes: buildPptx(lectureOneSpec()) },
    { fileName: 'Lecture 2 - Dead reckoning aloft.pptx', bytes: buildPptx(lectureTwoSpec()) },
  ];
}

const L1 = 'Lecture 1 - Reading a sky chart';
const L2 = 'Lecture 2 - Dead reckoning aloft';

/** Flashcards, exam questions and notes as a study pack (the app's own import format), so they pass the same checks as any pack. */
export const SAMPLE_PACK = {
  format: 'studyai-pack',
  version: 1,
  generator: 'Written by hand for the StudyAI demo (invented content)',
  name: 'Sample study material',
  lectures: [
    { ref: 'L1', title: L1, slideCount: 7 },
    { ref: 'L2', title: L2, slideCount: 7 },
  ],
  questions: [
    {
      type: 'mcq',
      prompt: 'What does a circle on the sky chart show?',
      marks: 1,
      difficulty: 1,
      topic: 'Chart symbols',
      lectures: ['L1'],
      options: [
        { text: 'A mooring mast', correct: true },
        { text: 'A beacon tower', correct: false },
        { text: 'A storm cell', correct: false },
        { text: 'The edge of a wind band', correct: false },
      ],
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 4, quote: 'A safe place to tie up the ship' }],
    },
    {
      type: 'truefalse',
      prompt: 'A tail wind takes speed away from the ground speed.',
      marks: 1,
      difficulty: 1,
      topic: 'Wind and ground speed',
      lectures: ['L2'],
      answer: false,
      basis: 'lecture',
      sources: [{ lecture: 'L2', slide: 4, quote: 'A tail wind adds its speed to your airspeed' }],
    },
    {
      type: 'mcq',
      prompt: 'Which wind band is best for a long leg?',
      marks: 1,
      difficulty: 1,
      topic: 'Wind bands',
      lectures: ['L1'],
      options: [
        { text: 'Band 1, from the ground to 500 m', correct: false },
        { text: 'Band 2, from 500 m to 1 500 m', correct: true },
        { text: 'Band 3, above 1 500 m', correct: false },
      ],
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 6, quote: 'Steady wind, best for long legs' }],
    },
    {
      type: 'short',
      prompt: 'What is dead reckoning, and why does it still work in cloud?',
      marks: 2,
      difficulty: 2,
      topic: 'Dead reckoning',
      lectures: ['L2'],
      modelAnswer: 'Dead reckoning is working out where you are from where you started, your heading, your speed and the time that has passed. It still works in cloud because it needs no landmarks.',
      rubric: [
        { text: 'It works out your position from the start, heading, speed and time', marks: 1, keywords: ['start', 'heading', 'speed', 'time'] },
        { text: 'It needs no landmarks, so it works in cloud', marks: 1, keywords: ['landmarks'] },
      ],
      expectedWords: [24, 40],
      hint: 'Slide 2 of the second lecture.',
      basis: 'lecture',
      sources: [{ lecture: 'L2', slide: 2, quote: 'It needs no landmarks, so it works in cloud' }],
    },
    {
      type: 'short',
      prompt: 'Name the four parts of a sky chart.',
      marks: 4,
      difficulty: 2,
      topic: 'Parts of a chart',
      lectures: ['L1'],
      modelAnswer: 'A sky chart has a legend that explains the symbols, a compass rose that shows north, wind bands that show how strong the wind is at each height, and landmarks that are the fixed points you steer by.',
      rubric: [
        { text: 'The legend', marks: 1, keywords: ['legend'] },
        { text: 'The compass rose', marks: 1, keywords: ['compass rose'] },
        { text: 'The wind bands', marks: 1, keywords: ['wind bands'] },
        { text: 'The landmarks', marks: 1, keywords: ['landmarks'] },
      ],
      expectedWords: [24, 80],
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 3, quote: 'Wind bands are shaded strips that show how strong the wind is at each height' }],
    },
    {
      type: 'calculation',
      prompt: 'A skyship has an airspeed of 20 km/h and flies into a head wind of 4 km/h for 2.5 hours. How far does it travel over the land? Show each step.',
      marks: 3,
      difficulty: 2,
      topic: 'Wind and ground speed',
      lectures: ['L2'],
      modelAnswer: 'A head wind takes its speed away, so the ground speed is 20 - 4 = 16 km/h. The distance is the ground speed multiplied by the time, 16 x 2.5 = 40 km.',
      rubric: [
        { text: 'Subtracts the head wind from the airspeed: ground speed 16 km/h', marks: 1, keywords: ['16'] },
        { text: 'Multiplies the ground speed by the time', marks: 1, keywords: ['2.5'] },
        { text: 'Gets 40 km', marks: 1, keywords: ['40'] },
      ],
      expectedWords: [20, 60],
      basis: 'lecture',
      sources: [
        { lecture: 'L2', slide: 4, quote: 'airspeed 20 km/h with a 4 km/h head wind gives a ground speed of 16 km/h' },
        { lecture: 'L2', slide: 3, quote: 'The distance travelled is the ground speed multiplied by the time' },
      ],
    },
    {
      type: 'scenario',
      prompt:
        'A skyship must fly from Mast 2 to Mast 5. On the chart the two masts are 8 cm apart and the scale is 1 : 500 000. The ground speed will be 20 km/h, and the last part of the leg is in thick cloud with no landmark in sight. How long will the leg take, and how will you keep track of your position in the cloud?',
      asks: [
        { quote: 'How long will the leg take', count: 2 },
        { quote: 'how will you keep track of your position in the cloud', count: 2 },
      ],
      marks: 4,
      difficulty: 3,
      topic: 'Dead reckoning',
      lectures: ['L1', 'L2'],
      modelAnswer:
        'The masts are 8 cm apart and 1 cm on the chart is 5 km in the air, so the leg is 8 x 5 = 40 km. At a ground speed of 20 km/h the leg takes 40 / 20 = 2 hours. In the cloud there is no landmark, so use dead reckoning from the last known position, the heading, the speed and the time, and correct the position as soon as a landmark comes into sight.',
      rubric: [
        { text: 'Turns 8 cm on the chart into 40 km in the air', marks: 1, ask: 1, keywords: ['40'] },
        { text: 'Divides the distance by the ground speed: 2 hours', marks: 1, ask: 1, keywords: ['2 hours'] },
        { text: 'Uses dead reckoning in the cloud, because it needs no landmarks', marks: 1, ask: 2, keywords: ['dead reckoning'] },
        { text: 'Corrects the position whenever a landmark is seen', marks: 1, ask: 2, keywords: ['correct'] },
      ],
      expectedWords: [48, 80],
      basis: 'derived',
      sources: [
        { lecture: 'L1', slide: 5, quote: 'A scale of 1 : 500 000 means that 1 cm on the chart is 5 km in the air' },
        { lecture: 'L2', slide: 3, quote: 'The distance travelled is the ground speed multiplied by the time' },
        { lecture: 'L2', slide: 2, quote: 'It needs no landmarks, so it works in cloud' },
        { lecture: 'L2', slide: 2, quote: 'so you correct it whenever you see a landmark' },
      ],
    },
    {
      type: 'compare',
      prompt: 'Compare wind band 1 and wind band 2, and say which one you would choose for a long leg.',
      marks: 3,
      difficulty: 2,
      topic: 'Wind bands',
      lectures: ['L1'],
      modelAnswer: 'Band 1 runs from the ground to 500 m and has light, gusty wind. Band 2 runs from 500 m to 1 500 m and has steady wind. Band 2 is the better choice for a long leg.',
      rubric: [
        { text: 'Band 1 is low and has light, gusty wind', marks: 1, keywords: ['gusty'] },
        { text: 'Band 2 is higher and has steady wind', marks: 1, keywords: ['steady'] },
        { text: 'Chooses band 2 for a long leg', marks: 1, keywords: ['band 2'] },
      ],
      expectedWords: [30, 60],
      basis: 'lecture',
      sources: [
        { lecture: 'L1', slide: 6, quote: 'Light, gusty wind' },
        { lecture: 'L1', slide: 6, quote: 'Steady wind, best for long legs' },
      ],
    },
  ],
  cards: [
    { type: 'definition', front: 'What is dead reckoning?', back: 'Working out where you are from where you started, your heading, your speed and the time that has passed.', lecture: 'L2', basis: 'lecture', tags: ['dead reckoning'], sources: [{ lecture: 'L2', slide: 2, quote: 'from where you started, your heading, your speed and the time that has passed' }] },
    { type: 'qa', front: 'Why does dead reckoning work in cloud?', back: 'It needs no landmarks.', lecture: 'L2', basis: 'lecture', tags: ['dead reckoning'], sources: [{ lecture: 'L2', slide: 2, quote: 'It needs no landmarks, so it works in cloud' }] },
    { type: 'concept', front: 'What happens to the error of dead reckoning, and what do you do about it?', back: 'It grows with every hour, so you correct it whenever you see a landmark.', lecture: 'L2', basis: 'lecture', tags: ['dead reckoning'], sources: [{ lecture: 'L2', slide: 2, quote: 'Its error grows with every hour' }] },
    { type: 'formula', front: 'How do you find the distance travelled?', back: 'Distance = ground speed × time.', lecture: 'L2', basis: 'lecture', tags: ['formulas'], sources: [{ lecture: 'L2', slide: 3, quote: 'The distance travelled is the ground speed multiplied by the time' }] },
    { type: 'formula', front: 'How does a wind change your ground speed?', back: 'Ground speed = airspeed + a tail wind, or airspeed − a head wind.', lecture: 'L2', basis: 'lecture', tags: ['formulas'], sources: [{ lecture: 'L2', slide: 4, quote: 'A tail wind adds its speed to your airspeed' }] },
    { type: 'qa', front: 'Airspeed 20 km/h and a 4 km/h head wind: what is the ground speed?', back: '16 km/h.', lecture: 'L2', basis: 'lecture', tags: ['formulas'], sources: [{ lecture: 'L2', slide: 4, quote: 'airspeed 20 km/h with a 4 km/h head wind gives a ground speed of 16 km/h' }] },
    { type: 'code', front: 'What is the first step of PLOT-LEG?', back: 'It works out the distance: ground_speed * hours.', lecture: 'L2', basis: 'lecture', tags: ['plotting'], sources: [{ lecture: 'L2', slide: 5, quote: 'distance = ground_speed * hours' }] },
    { type: 'definition', front: 'What does a triangle on a sky chart show?', back: 'A beacon tower: a fixed light that can be seen from 40 km away.', lecture: 'L1', basis: 'lecture', tags: ['symbols'], sources: [{ lecture: 'L1', slide: 4, quote: 'A fixed light that can be seen from 40 km away' }] },
    { type: 'definition', front: 'What does a circle on a sky chart show?', back: 'A mooring mast: a safe place to tie up the ship.', lecture: 'L1', basis: 'lecture', tags: ['symbols'], sources: [{ lecture: 'L1', slide: 4, quote: 'A safe place to tie up the ship' }] },
    { type: 'qa', front: 'How far away should you keep from a storm cell?', back: 'At least 15 km.', lecture: 'L1', basis: 'lecture', tags: ['symbols'], sources: [{ lecture: 'L1', slide: 4, quote: 'Keep at least 15 km away' }] },
    { type: 'formula', front: 'How do you turn a distance on the chart into a distance in the air?', back: 'Distance in the air = distance on the chart × scale. At a scale of 1 : 500 000, 1 cm on the chart is 5 km in the air.', lecture: 'L1', basis: 'lecture', tags: ['formulas'], sources: [{ lecture: 'L1', slide: 5, quote: 'A scale of 1 : 500 000 means that 1 cm on the chart is 5 km in the air' }] },
    { type: 'qa', front: 'How far in the air is 6 cm on a chart with scale 1 : 500 000?', back: '30 km.', lecture: 'L1', basis: 'lecture', tags: ['formulas'], sources: [{ lecture: 'L1', slide: 5, quote: '6 cm on a chart with scale 1 : 500 000 is 30 km in the air' }] },
    { type: 'comparison', front: 'Compare wind band 1 and wind band 2.', back: 'Band 1 (ground to 500 m) has light, gusty wind. Band 2 (500 m to 1 500 m) has steady wind and is best for long legs.', lecture: 'L1', basis: 'lecture', tags: ['wind bands'], sources: [{ lecture: 'L1', slide: 6, quote: 'Steady wind, best for long legs' }] },
  ],
  notes: [
    {
      title: 'Lecture 1 in brief: reading a sky chart',
      kind: 'summary',
      lecture: 'L1',
      blocks: [
        { text: 'A sky chart has four parts: the **legend**, the **compass rose**, the **wind bands** and the **landmarks**.', basis: 'lecture', sources: [{ lecture: 'L1', slide: 3, quote: 'The legend explains every symbol on the chart' }] },
        { text: 'Distance in the air is the distance on the chart times the scale: $d_{air} = d_{chart} \\times S$. At 1 : 500 000, one centimetre is five kilometres.', basis: 'lecture', sources: [{ lecture: 'L1', slide: 5, quote: 'A scale of 1 : 500 000 means that 1 cm on the chart is 5 km in the air' }] },
      ],
    },
    {
      title: 'Lecture 2 in brief: dead reckoning',
      kind: 'summary',
      lecture: 'L2',
      blocks: [
        { text: 'Dead reckoning needs the start, the heading, the speed and the time. It works in cloud, but its error grows, so correct it at every landmark.', basis: 'lecture', sources: [{ lecture: 'L2', slide: 2, quote: 'Its error grows with every hour' }] },
        { text: 'Ground speed is airspeed plus a tail wind or minus a head wind: $v_g = v_a \\pm v_w$. Then $d = v \\times t$.', basis: 'lecture', sources: [{ lecture: 'L2', slide: 4, quote: 'A head wind takes its speed away' }] },
      ],
    },
  ],
};

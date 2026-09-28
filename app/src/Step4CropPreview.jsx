import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Itinerary } from './App.jsx';
import { Editor } from './Workspace.jsx';
import sample from '../data/sample-itinerary-africa.json';
import './styles.css';
import './workspace.css';
import './agent-planner.css';
import './web-fonts.css';

function CropPreview() {
  const [project, setProject] = useState(() => ({
    id: 'crop-preview-only',
    ownerId: 'preview-only',
    title: sample.title,
    data: structuredClone(sample),
    workflowStage: 'generated',
    versions: [],
    visibility: {},
  }));
  return <>
    <div style={{ position: 'fixed', zIndex: 100, bottom: 12, left: 12, padding: '8px 12px', borderRadius: 6, background: '#3f3930', color: '#fff', fontSize: 12 }}>Step 4 四项修改预览 · 替代数据 · 调整不会保存到正式项目</div>
    <Editor project={project} ItineraryComponent={Itinerary} onProject={setProject} initialSelection={{ module: 'days', itemIndex: 1, subItemIndex: 0, imageIndex: 0 }} initialTab="image" openPickerOnImageClick canOpenVersions={false} />
  </>;
}

createRoot(document.getElementById('root')).render(<CropPreview />);

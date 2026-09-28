import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Itinerary } from './App.jsx';
import { Editor } from './Workspace.jsx';
import sample from '../data/sample-itinerary-africa.json';
import './styles.css';
import './workspace.css';
import './agent-planner.css';
import './web-fonts.css';

const labels = { location: '位置', rooms: '客房', design: '设计', facilities: '设施' };
const examples = {
  location: '酒店位于阿鲁沙梅鲁山麓，方便衔接抵达日与后续游猎行程。',
  rooms: '客房设有独立休息区，部分房间可欣赏花园景观。',
  design: '公共空间以当地自然元素与现代线条搭配，呈现安静的度假氛围。',
  facilities: '酒店设有泳池、餐厅与休息空间，可在行程间隙放松。',
};
const alternative = {
  location: '酒店坐落在阿鲁沙市区附近，适合作为长途飞行后的首晚下榻地。',
  rooms: '客房以舒适的休息体验为主，房型与景观以实际预订为准。',
  design: '室内设计结合温暖材质与东非风格元素。',
  facilities: '酒店提供餐饮与休闲设施，具体开放情况以酒店公告为准。',
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 1300));

function initialProject() {
  const data = structuredClone(sample);
  data.hotels[0].factRows = [
    { key: 'location', label: '位置', text: examples.location, status: 'success' },
    { key: 'rooms', label: '客房', text: examples.rooms, status: 'success' },
    { key: 'design', label: '设计', text: '', status: 'not_found' },
    { key: 'facilities', label: '设施', text: '', status: 'not_found' },
  ];
  return {
    id: 'hotel-fact-preview-only', ownerId: 'preview-only', title: data.title,
    data, workflowStage: 'generated', versions: [], visibility: {},
  };
}

function HotelFactPreview() {
  const [project, setProject] = useState(initialProject);
  const updateFact = (hotelId, key, text) => {
    setProject((current) => {
      const next = structuredClone(current);
      const hotel = next.data.hotels.find((item) => item.id === hotelId);
      if (!hotel) return current;
      hotel.factRows = hotel.factRows.map((row) => row.key === key ? { ...row, text, status: 'success' } : row);
      return next;
    });
  };
  const search = async ({ hotelId, keys, mode }) => {
    await pause();
    if (mode === 'fill') {
      const hotel = project.data.hotels.find((item) => item.id === hotelId);
      const appliedRows = keys.filter((key) => !hotel?.factRows?.find((row) => row.key === key)?.text).map((key) => ({ key, text: examples[key] }));
      setProject((current) => {
        const next = structuredClone(current);
        const target = next.data.hotels.find((item) => item.id === hotelId);
        if (!target) return current;
        target.factRows = target.factRows.map((row) => {
          const found = appliedRows.find((item) => item.key === row.key);
          return found && !row.text ? { ...row, text: found.text, status: 'success' } : row;
        });
        return next;
      });
      return { appliedRows, missingKeys: [] };
    }
    const key = keys[0];
    const expectedText = project.data.hotels.find((item) => item.id === hotelId)?.factRows?.find((row) => row.key === key)?.text || '';
    return {
      expectedText,
      candidates: [{ key, label: labels[key], text: alternative[key], source: { sourceUrl: 'https://example.com', sourceTitle: '模拟来源，仅用于界面体验' } }],
    };
  };
  return <>
    <div style={{ position: 'fixed', zIndex: 100, bottom: 12, left: 12, padding: '8px 12px', borderRadius: 6, background: '#3f3930', color: '#fff', fontSize: 12 }}>
      Step 4 酒店信息预览 · 替代数据与模拟查找结果 · 不联网查酒店，也不保存到项目
    </div>
    <Editor project={project} ItineraryComponent={Itinerary} onProject={setProject}
      initialSelection={{ module: 'hotels', itemIndex: 0, subItemIndex: null, imageIndex: 0 }}
      initialTab="copy" canOpenVersions={false} onHotelFactSearch={search}
      onReplaceHotelFact={async ({ hotelId, key, text }) => updateFact(hotelId, key, text)} />
  </>;
}

createRoot(document.getElementById('root')).render(<HotelFactPreview />);
